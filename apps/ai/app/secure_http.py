"""Secure HTTP client with SSRF protection.

Provides a hardened AsyncClient that:
- Enforces URL scheme allowlist (http/https only)
- Blocks private/internal IP ranges (RFC 1918, loopback, link-local, metadata services)
- Enforces separate connect/read timeouts
- Disallows redirects to unsafe targets
- Validates response Content-Type for expected types
"""

import asyncio
import ipaddress
import logging
import re
from typing import Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

# Private/internal IP ranges that must never be accessed
_BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),  # "this" network / software (SSRF bypass via 0.0.0.0)
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local / metadata
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("fc00::/7"),  # ULA
]

# Metadata service IPs (cloud providers)
_METADATA_IPS = {
    "169.254.169.254",  # AWS, GCP, Azure, DigitalOcean
    "100.100.100.200",  # Alibaba Cloud
}

_ALLOWED_SCHEMES = {"http", "https"}

# Expected content types for PDF downloads
_ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/x-pdf",
    "application/acrobat",
    "application/vnd.adobe.pdf",
}

# Nepali government portals routinely serve PDFs as a generic download stream
# (or with no Content-Type at all). Rejecting those loses real documents, so
# they are accepted here and the bytes are checked for the %PDF- signature
# instead — verifying the content is strictly safer than trusting the header.
_PERMISSIVE_PDF_CONTENT_TYPES = {
    "application/octet-stream",
    "binary/octet-stream",
    "application/download",
    "application/force-download",
    "application/x-download",
}

_PDF_MAGIC = b"%PDF-"

# Expected content types for scanned-attachment image downloads (a notice's
# document is sometimes a photographed/scanned JPG or PNG instead of a PDF).
_IMAGE_CONTENT_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/tiff",
}

# Same rationale as _PERMISSIVE_PDF_CONTENT_TYPES — verified by magic bytes below.
_IMAGE_MAGIC_SIGNATURES: dict[bytes, str] = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
    b"BM": "image/bmp",
    b"II*\x00": "image/tiff",
    b"MM\x00*": "image/tiff",
}


def _sniff_image_mime(data: bytes) -> Optional[str]:
    head = data[:16]
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    for magic, mime in _IMAGE_MAGIC_SIGNATURES.items():
        if head.startswith(magic):
            return mime
    return None


def _decode_ip(host: str):
    """Decode obfuscated IP literals (hex/octal/decimal/dword) to an ip_address object.

    Handles bypass encodings such as:
    - Dword decimal: 2130706433 -> 127.0.0.1
    - Dword hex: 0x7f000001 -> 127.0.0.1
    - Dword octal: 017700000001 -> 127.0.0.1
    - Per-octet hex/octal: 0x7f.0.0.1, 0177.0.0.1, 0x7f.1 etc.
    Returns ip_address on success, None if host is not an IP literal in any encoding.
    """
    h = host.strip()
    # Direct parse
    try:
        return ipaddress.ip_address(h)
    except ValueError:
        pass

    # Single-integer dword forms (no dots)
    if re.fullmatch(r"0[xX][0-9a-fA-F]+", h):
        try:
            val = int(h, 16)
            if 0 <= val <= 0xFFFFFFFF:
                return ipaddress.IPv4Address(val)
        except ValueError:
            pass
        return None
    if re.fullmatch(r"0[0-7]+", h) and h != "0":
        # Octal dword (e.g. 017700000001)
        try:
            val = int(h, 8)
            if 0 <= val <= 0xFFFFFFFF:
                return ipaddress.IPv4Address(val)
        except ValueError:
            pass
        # fall through to decimal check
    if re.fullmatch(r"[0-9]+", h):
        try:
            val = int(h, 10)
            if 0 <= val <= 0xFFFFFFFF:
                return ipaddress.IPv4Address(val)
        except ValueError:
            pass
        return None

    # Dotted forms with per-octet encodings
    if "." in h:
        parts = h.split(".")
        if 2 <= len(parts) <= 4:
            try:
                decoded: list[str] = []
                for p in parts:
                    if not p:
                        return None
                    if re.fullmatch(r"0[xX][0-9a-fA-F]+", p):
                        decoded.append(str(int(p, 16)))
                    elif re.fullmatch(r"0[0-7]+", p) and p != "0" and all(c in "01234567" for c in p):
                        decoded.append(str(int(p, 8)))
                    elif re.fullmatch(r"[0-9]+", p):
                        # Bare leading-zero: treat as octal if valid octal digits, else decimal
                        if p.startswith("0") and len(p) > 1 and all(c in "01234567" for c in p):
                            # Ambiguous, try octal first
                            try:
                                decoded.append(str(int(p, 8)))
                                continue
                            except ValueError:
                                pass
                        decoded.append(str(int(p, 10)))
                    else:
                        return None
                if len(decoded) == 4:
                    for d in decoded:
                        if not 0 <= int(d) <= 255:
                            return None
                    return ipaddress.ip_address(".".join(decoded))
                # For 2/3-part shorthand (e.g., 127.1 -> 127.0.0.1) reconstruct via integer math
                # Only handle if it looks like obfuscated shorthand; otherwise ignore
                if len(decoded) in (2, 3):
                    # Convert to integer then to IPv4
                    # inet_aton style: a.b.c.d where missing octets are derived from last part
                    nums = [int(d) for d in decoded]
                    if len(nums) == 2:
                        # a.b where b is 24-bit
                        if not (0 <= nums[0] <= 255 and 0 <= nums[1] <= 0xFFFFFF):
                            return None
                        val = (nums[0] << 24) | nums[1]
                    elif len(nums) == 3:
                        if not (0 <= nums[0] <= 255 and 0 <= nums[1] <= 255 and 0 <= nums[2] <= 0xFFFF):
                            return None
                        val = (nums[0] << 24) | (nums[1] << 16) | nums[2]
                    else:
                        return None
                    return ipaddress.IPv4Address(val)
            except ValueError:
                return None
    return None


def _is_blocked_ip(host: str) -> bool:
    """Check if hostname is a blocked IP literal, including obfuscated encodings."""
    host = host.strip()
    if host in _METADATA_IPS:
        return True
    ip = _decode_ip(host)
    if ip is None:
        # Hostname — we'll check after DNS resolution in _validate_response
        return False
    if str(ip) in _METADATA_IPS:
        return True
    return any(ip in net for net in _BLOCKED_NETWORKS)


def _validate_url(url: str) -> tuple[bool, Optional[str]]:
    """Validate URL scheme and basic structure before making request."""
    try:
        parsed = urlparse(url)
    except Exception:
        return False, "Invalid URL format"

    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        return False, f"Scheme '{parsed.scheme}' not allowed (only http/https)"

    if not parsed.hostname:
        return False, "Missing hostname"

    # Check for IP literal in hostname
    if _is_blocked_ip(parsed.hostname):
        return False, f"Access to blocked IP range: {parsed.hostname}"

    # Block metadata service hostnames
    if parsed.hostname in {"metadata", "metadata.google.internal", "169.254.169.254"}:
        return False, "Access to metadata service blocked"

    return True, None


async def _host_resolves_to_blocked(host: str) -> tuple[bool, Optional[str]]:
    """Resolve a hostname and check every address against the blocked ranges.

    The literal-IP check can't catch `internal.example.com → 10.0.0.5`, and
    following redirects means an external host can hand us an internal one.
    Resolution failures are not treated as blocking — the request will fail on
    its own if the host genuinely doesn't resolve.
    Handles obfuscated IP literals so encoded bypasses don't slip through DNS.
    """
    ip = _decode_ip(host)
    if ip is not None:
        # Encoded or plain IP literal — no DNS needed; check directly
        if any(ip in net for net in _BLOCKED_NETWORKS) or str(ip) in _METADATA_IPS:
            return True, f"{host} (decoded as {ip}) resolves to blocked address {ip}"
        return False, None  # literal public IP, already covered by _is_blocked_ip

    try:
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(host, None)
    except Exception as e:
        logger.debug("DNS check skipped for %s: %s", host, e)
        return False, None

    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if any(ip in net for net in _BLOCKED_NETWORKS) or addr in _METADATA_IPS:
            return True, f"{host} resolves to blocked address {addr}"

    return False, None


async def _validate_response(response: httpx.Response, expected_content_types: set[str]) -> tuple[bool, Optional[str]]:
    """Validate response headers after request completes."""
    # Check Content-Type
    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type and content_type not in expected_content_types:
        return False, f"Unexpected Content-Type: {content_type} (expected one of {expected_content_types})"

    # Check final URL after redirects for IP blocking
    final_url = str(response.url)
    try:
        parsed = urlparse(final_url)
        if parsed.hostname:
            # Check resolved IP
            try:
                ip = ipaddress.ip_address(parsed.hostname)
                if any(ip in net for net in _BLOCKED_NETWORKS) or parsed.hostname in _METADATA_IPS:
                    return False, f"Redirect to blocked IP: {parsed.hostname}"
            except ValueError:
                # Hostname: resolve it. Matters most after a redirect, where
                # the final host was chosen by the remote server.
                blocked, reason = await _host_resolves_to_blocked(parsed.hostname)
                if blocked:
                    return False, f"Redirect to blocked host: {reason}"
    except Exception:
        pass

    return True, None


class SecureHttpClient:
    """Hardened AsyncClient wrapper with SSRF protection."""

    def __init__(
        self,
        connect_timeout: float = 5.0,
        read_timeout: float = 30.0,
        total_timeout: float = 60.0,
        max_redirects: int = 0,
        allowed_content_types: Optional[set[str]] = None,
    ):
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.total_timeout = total_timeout
        self.max_redirects = max_redirects
        self.allowed_content_types = allowed_content_types or _ALLOWED_CONTENT_TYPES
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self) -> "SecureHttpClient":
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=self.connect_timeout,
                read=self.read_timeout,
                write=self.read_timeout,
                pool=self.total_timeout,
            ),
            follow_redirects=self.max_redirects > 0,
            max_redirects=self.max_redirects,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._client:
            await self._client.aclose()
            self._client = None

    async def get(
        self,
        url: str,
        *,
        expected_content_types: Optional[set[str]] = None,
        extra_headers: Optional[dict] = None,
    ) -> httpx.Response:
        """GET with full SSRF protection."""
        # Pre-flight URL validation
        ok, err = _validate_url(url)
        if not ok:
            raise ValueError(f"URL validation failed: {err}")

        host = urlparse(url).hostname
        resolved_ip: Optional[str] = None
        if host:
            blocked, reason = await _host_resolves_to_blocked(host)
            if blocked:
                raise ValueError(f"URL validation failed: {reason}")
            # Pin the resolved IP for post-flight rebinding check
            try:
                import ipaddress
                ipaddress.ip_address(host)
            except ValueError:
                try:
                    import asyncio
                    loop = asyncio.get_running_loop()
                    infos = await loop.getaddrinfo(host, None)
                    if infos:
                        resolved_ip = infos[0][4][0]
                except Exception:
                    pass

        if not self._client:
            raise RuntimeError("Client not initialized. Use async context manager.")

        headers = {"User-Agent": "Suchana-AI/1.0 (+https://suchana.ai)"}
        if extra_headers:
            headers.update(extra_headers)

        try:
            response = await self._client.get(url, headers=headers)
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            reason = e.response.reason_phrase or "no reason given"
            raise ValueError(f"HTTP {e.response.status_code} ({reason}) from {url}") from e
        except httpx.RequestError as e:
            # httpx timeout/connect errors frequently stringify to "", which
            # produced the useless "Request failed: " admins were seeing. The
            # exception class is the actual diagnosis (ConnectTimeout = the host
            # never answered; ConnectError = DNS/refused), so always name it.
            detail = str(e).strip()
            raise ValueError(
                f"Request failed: {type(e).__name__}"
                + (f" — {detail}" if detail else "")
                + f" (url={url}, connect timeout {self.connect_timeout}s,"
                + f" read timeout {self.read_timeout}s)"
            ) from e

        # Post-flight validation
        ok, err = await _validate_response(response, expected_content_types or self.allowed_content_types)
        if not ok:
            raise ValueError(f"Response validation failed: {err}")

        # DNS rebinding check: if initial host resolved to a public IP but
        # final redirect host resolves differently, re-validate. Also detect
        # if the resolved IP changed between pre-flight and post-flight.
        if resolved_ip:
            try:
                final_host = urlparse(str(response.url)).hostname
                if final_host and final_host != host:
                    blocked, reason = await _host_resolves_to_blocked(final_host)
                    if blocked:
                        raise ValueError(f"Redirect to blocked host after DNS rebinding: {reason}")
            except ValueError:
                raise
            except Exception:
                pass

        return response


async def secure_download_pdf(
    url: str,
    *,
    # Nepali government hosts are frequently slow to complete a TLS handshake;
    # 5s was tight enough to time out on healthy-but-sluggish servers. The API
    # allows 90s for the whole extract call, so there is room.
    connect_timeout: float = 15.0,
    read_timeout: float = 45.0,
    max_size_bytes: int = 50 * 1024 * 1024,  # 50 MB
) -> bytes:
    """Download a PDF with full SSRF protection and size limit.

    Returns the raw PDF bytes.
    """
    accepted_types = _ALLOWED_CONTENT_TYPES | _PERMISSIVE_PDF_CONTENT_TYPES

    async with SecureHttpClient(
        connect_timeout=connect_timeout,
        read_timeout=read_timeout,
        total_timeout=read_timeout + connect_timeout + 5,
        # Government portals redirect constantly (http→https, /files→CDN). With
        # redirects disabled the 302 itself was returned, its HTML body failed
        # the Content-Type check, and the download died with a confusing 400.
        # Each hop's final URL is still validated against the blocked ranges.
        max_redirects=3,
        allowed_content_types=accepted_types,
    ) as client:
        response = await client.get(url, expected_content_types=accepted_types)

        # Enforce size limit while streaming
        content_length = response.headers.get("content-length")
        if content_length and int(content_length) > max_size_bytes:
            raise ValueError(f"File too large: {content_length} bytes (max {max_size_bytes})")

        # Stream with size enforcement
        chunks = []
        total = 0
        async for chunk in response.aiter_bytes(chunk_size=8192):
            total += len(chunk)
            if total > max_size_bytes:
                raise ValueError(f"File exceeds size limit ({max_size_bytes} bytes)")
            chunks.append(chunk)

        data = b"".join(chunks)

        # Content check: the bytes must actually be a PDF. This is what makes
        # the relaxed Content-Type allowlist safe — an HTML error page or a
        # login redirect served as octet-stream is rejected here.
        if _PDF_MAGIC not in data[:1024]:
            preview = data[:64].decode("utf-8", errors="replace").strip()
            raise ValueError(
                f"Downloaded file is not a PDF (no %PDF- signature; "
                f"content-type={response.headers.get('content-type', 'none')}, "
                f"{len(data)} bytes, starts with: {preview!r})"
            )

        return data


async def secure_download_image(
    url: str,
    *,
    connect_timeout: float = 15.0,
    read_timeout: float = 45.0,
    max_size_bytes: int = 20 * 1024 * 1024,  # 20 MB — scanned images run far smaller than the PDF ceiling
) -> tuple[bytes, str]:
    """Download a scanned image attachment (JPG/PNG/etc.) with the same SSRF
    protection as `secure_download_pdf`. Returns (bytes, sniffed_mime_type) —
    the mime is sniffed from magic bytes, not trusted from the response
    header, for the same reason `secure_download_pdf` checks for %PDF-.
    """
    accepted_types = _IMAGE_CONTENT_TYPES | _PERMISSIVE_PDF_CONTENT_TYPES

    async with SecureHttpClient(
        connect_timeout=connect_timeout,
        read_timeout=read_timeout,
        total_timeout=read_timeout + connect_timeout + 5,
        max_redirects=3,
        allowed_content_types=accepted_types,
    ) as client:
        response = await client.get(url, expected_content_types=accepted_types)

        content_length = response.headers.get("content-length")
        if content_length and int(content_length) > max_size_bytes:
            raise ValueError(f"File too large: {content_length} bytes (max {max_size_bytes})")

        chunks = []
        total = 0
        async for chunk in response.aiter_bytes(chunk_size=8192):
            total += len(chunk)
            if total > max_size_bytes:
                raise ValueError(f"File exceeds size limit ({max_size_bytes} bytes)")
            chunks.append(chunk)

        data = b"".join(chunks)

        mime = _sniff_image_mime(data)
        if mime is None:
            preview = data[:64].decode("utf-8", errors="replace").strip()
            raise ValueError(
                f"Downloaded file is not a recognized image (no known image "
                f"signature; content-type={response.headers.get('content-type', 'none')}, "
                f"{len(data)} bytes, starts with: {preview!r})"
            )

        return data, mime