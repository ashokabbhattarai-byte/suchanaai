"use client"

import { useState } from "react"
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Compass,
  Info,
  Link2,
  Loader2,
  RefreshCw,
  Stethoscope,
  Wrench,
} from "lucide-react"
import type { ScrapeDiagnosis, ScrapeFailure, ScrapeSource } from "@/lib/types"

/**
 * Why a source's last run failed, and what to do about it.
 *
 * The card used to print the run's raw aggregate error, then repeat the same
 * sentence under every URL that produced it — three copies of "Could not
 * detect a working listing pattern", or a bare "Request failed with status
 * code 504", and no indication of what to change. This renders the diagnosis
 * instead: one plain-language headline per finding, the reason, the
 * recommended fix, and the buttons that carry it out. The raw stage/URL list
 * is still there, one disclosure away, for when the plain answer isn't enough.
 */

interface Props {
  source: ScrapeSource
  isRunning: boolean
  /** `${sourceId}:${code}` of the fix currently being applied, if any. */
  applyingFix: string | null
  diagnosing: boolean
  onApplyFix: (diagnosis: ScrapeDiagnosis) => void
  onAutoDetect: () => void
  onEdit: () => void
  onRun: () => void
  onDiagnose: () => void
}

/**
 * Plain-language reading of a raw run error, for sources whose last failure
 * predates the diagnosis feature or whose analysis has not run yet. Deliberately
 * conservative: anything unrecognised is shown verbatim rather than guessed at.
 */
function humanizeError(raw: string): { title: string; detail: string; fix: string } | null {
  const text = raw.toLowerCase()

  if (text.includes("504") || text.includes("timeout") || text.includes("timed out")) {
    return {
      title: "The crawl ran out of time",
      detail:
        "The site did not finish responding within the run's time limit. That is usually a slow or overloaded site, or a listing large enough that one run cannot finish it.",
      fix: "Run it again — partial progress is kept. If it keeps timing out, lower “Max pages” or raise the poll interval so each run does less work.",
    }
  }
  if (text.includes("502") || text.includes("503")) {
    return {
      title: "The site was unavailable",
      detail: "The server returned a gateway error, so no page could be read. This is the site being down or overloaded, not a configuration problem.",
      fix: "Run it again later. If it persists for hours, check the site in a browser.",
    }
  }
  if (text.includes("403") || text.includes("forbidden") || text.includes("cloudflare")) {
    return {
      title: "The site refused the request",
      detail: "Responses look like a bot check or rate limit rather than a missing page, so the URL is probably fine — the requests are being blocked.",
      fix: "Raise this source's poll interval so it is crawled less often, then run it again.",
    }
  }
  if (text.includes("404") || text.includes("not found")) {
    return {
      title: "The listing page no longer exists",
      detail: "The configured URL returns “not found”, so there was nothing to crawl. This is a wrong or outdated URL.",
      fix: "Use “Auto-detect URLs” to find where the section moved, or edit the source and correct it by hand.",
    }
  }
  if (text.includes("enotfound") || text.includes("eai_again") || text.includes("name_not_resolved")) {
    return {
      title: "The domain could not be reached",
      detail: "DNS lookups for this site failed, so no page was ever loaded.",
      fix: "Check the base URL for a typo and whether the domain is still live.",
    }
  }
  if (text.includes("econnrefused") || text.includes("econnreset")) {
    return {
      title: "The site refused the connection",
      detail: "The server actively rejected the connection rather than answering it.",
      fix: "Run it again later. If it persists, confirm the site is reachable from this server.",
    }
  }
  if (text.includes("could not detect a working listing pattern")) {
    return {
      title: "No list of notices was found on the page",
      detail:
        "The page loaded, but nothing on it repeats like a list of notices. It is a landing page, an embedded document viewer, or it builds its list in the browser after loading.",
      fix: "Run “Diagnose” to search the site for a page that does list notices, or try this source's sitemap instead.",
    }
  }
  return null
}

const SEVERITY_STYLES = {
  error: {
    wrap: "border-red-200 bg-red-50/70",
    chip: "bg-red-100 text-red-700",
    title: "text-red-900",
    body: "text-red-900/80",
    Icon: AlertCircle,
  },
  warning: {
    wrap: "border-amber-200 bg-amber-50/70",
    chip: "bg-amber-100 text-amber-800",
    title: "text-amber-900",
    body: "text-amber-900/80",
    Icon: AlertTriangle,
  },
  info: {
    wrap: "border-vez-line bg-vez-surface",
    chip: "bg-vez-navy/10 text-vez-navy",
    title: "text-vez-ink",
    body: "text-vez-mute",
    Icon: Info,
  },
} as const

/** The raw per-URL failure list, hidden until asked for. */
function TechnicalDetails({ failures }: { failures: ScrapeFailure[] }) {
  const [open, setOpen] = useState(false)
  const hard = failures.filter((f) => (f.outcome ?? "failed") === "failed")
  const skipped = failures.length - hard.length
  if (!failures.length) return null

  return (
    <div className="mt-2.5 border-t border-black/[0.06] pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-vez-mute transition-colors hover:text-vez-ink"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Technical details ({hard.length} failed
        {skipped > 0 && `, ${skipped} skipped`})
      </button>
      {open && (
        <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
          {failures.slice(0, 12).map((f, i) => (
            <li key={`${f.url}-${i}`} className="text-[11px]">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                  (f.outcome ?? "failed") === "failed"
                    ? "bg-red-100 text-red-700"
                    : "bg-vez-navy/10 text-vez-mute"
                }`}
              >
                {f.stage}
              </span>{" "}
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-vez-navy underline-offset-2 hover:underline"
              >
                {f.url}
              </a>
              <span className="block text-vez-mute">{f.error}</span>
            </li>
          ))}
          {failures.length > 12 && (
            <li className="text-[11px] text-vez-mute">+{failures.length - 12} more</li>
          )}
        </ul>
      )}
    </div>
  )
}

export function SourceDiagnosis({
  source,
  isRunning,
  applyingFix,
  diagnosing,
  onApplyFix,
  onAutoDetect,
  onEdit,
  onRun,
  onDiagnose,
}: Props) {
  const failures = source.lastFailedUrls ?? []
  const diagnoses = source.lastDiagnosis ?? []
  const failed = source.lastStatus === "FAILED"
  const hardFailures = failures.filter((f) => (f.outcome ?? "failed") === "failed")

  if (isRunning) return null
  // A healthy run with some partial failures still deserves a note; a healthy
  // run with none deserves silence.
  if (!failed && !diagnoses.length && hardFailures.length === 0) return null

  // Nothing analysed yet — read the raw error as best we can and offer the
  // analysis as the primary action.
  if (!diagnoses.length) {
    const raw = source.lastError || (failed ? "The scrape run failed." : "")
    const human = raw ? humanizeError(raw) : null
    const style = failed ? SEVERITY_STYLES.error : SEVERITY_STYLES.warning
    const { Icon } = style

    return (
      <div className={`mb-4 rounded-[12px] border px-3 py-2.5 text-xs ${style.wrap}`}>
        <p className={`flex items-start gap-1.5 font-medium ${style.title}`}>
          <Icon className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">
            {human?.title ??
              (failed
                ? raw || "The scrape run failed."
                : `${hardFailures.length} page(s) failed during the last run`)}
          </span>
        </p>
        {human && <p className={`mt-1.5 ${style.body}`}>{human.detail}</p>}
        {human && (
          <p className={`mt-1.5 flex gap-1.5 ${style.title}`}>
            <Wrench className="mt-0.5 size-3 shrink-0" />
            <span>{human.fix}</span>
          </p>
        )}
        {human && raw && (
          <p className="mt-1.5 text-[11px] text-vez-mute">
            Reported as: <span className="break-words">{raw}</span>
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onDiagnose}
            disabled={diagnosing}
            className="flex items-center gap-1.5 rounded-full bg-vez-navy px-3 py-1.5 text-[11px] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {diagnosing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Stethoscope className="size-3" />
            )}
            {diagnosing ? "Analysing the site…" : "Diagnose & recommend a fix"}
          </button>
          <button
            type="button"
            onClick={onRun}
            className="rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-[11px] text-vez-ink transition-colors hover:bg-white"
          >
            Run again
          </button>
        </div>

        <TechnicalDetails failures={failures} />
      </div>
    )
  }

  return (
    <div className="mb-4 space-y-2">
      {diagnoses.map((d) => {
        const style = SEVERITY_STYLES[d.severity] ?? SEVERITY_STYLES.info
        const { Icon } = style
        const applying = applyingFix === `${source.id}:${d.code}`
        const patchFields = Object.entries(d.patch)

        return (
          <div key={d.code} className={`rounded-[12px] border px-3 py-2.5 text-xs ${style.wrap}`}>
            <p className={`flex items-start gap-1.5 font-medium ${style.title}`}>
              <Icon className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-words">{d.title}</span>
            </p>

            {d.detail && <p className={`mt-1.5 ${style.body}`}>{d.detail}</p>}

            {d.fix && (
              <div className="mt-2 rounded-[8px] bg-white/60 px-2.5 py-2">
                <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-vez-mute">
                  Recommended
                </p>
                <p className={style.title}>{d.fix}</p>
                {patchFields.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {patchFields.map(([field, value]) => (
                      <li key={field} className="text-[11px] text-vez-mute">
                        <span className="font-medium text-vez-ink">{field}</span>
                        {" → "}
                        <span className="break-all">{String(value)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {d.urls.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {d.urls.map((u) => (
                  <li key={u} className="flex items-start gap-1">
                    <Link2 className="mt-0.5 size-3 shrink-0 text-vez-mute" />
                    <a
                      href={u}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-[11px] text-vez-navy underline-offset-2 hover:underline"
                    >
                      {u}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {patchFields.length > 0 && (
                <button
                  type="button"
                  onClick={() => onApplyFix(d)}
                  disabled={applying}
                  className="flex items-center gap-1.5 rounded-full bg-vez-navy px-3 py-1.5 text-[11px] text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {applying ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Wrench className="size-3" />
                  )}
                  {applying ? "Applying…" : "Apply fix"}
                </button>
              )}
              {d.actions.includes("discover_routes") && (
                <button
                  type="button"
                  onClick={onAutoDetect}
                  className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-[11px] text-vez-ink transition-colors hover:bg-white"
                >
                  <Compass className="size-3" /> Auto-detect URLs
                </button>
              )}
              {d.actions.includes("detect_sitemap") && (
                <button
                  type="button"
                  onClick={onEdit}
                  className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-[11px] text-vez-ink transition-colors hover:bg-white"
                >
                  <Link2 className="size-3" /> Try sitemap
                </button>
              )}
              {d.actions.includes("edit_source") && (
                <button
                  type="button"
                  onClick={onEdit}
                  className="rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-[11px] text-vez-ink transition-colors hover:bg-white"
                >
                  Edit source
                </button>
              )}
              {d.actions.includes("retry") && (
                <button
                  type="button"
                  onClick={onRun}
                  className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-[11px] text-vez-ink transition-colors hover:bg-white"
                >
                  <RefreshCw className="size-3" /> Run again
                </button>
              )}
            </div>
          </div>
        )
      })}

      <div className="rounded-[12px] border border-vez-line bg-vez-surface px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-vez-mute">
            {source.lastDiagnosedAt &&
              `Analysed ${new Date(source.lastDiagnosedAt).toLocaleString()}`}
          </span>
          <button
            type="button"
            onClick={onDiagnose}
            disabled={diagnosing}
            className="flex items-center gap-1.5 text-[11px] text-vez-navy transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            {diagnosing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {diagnosing ? "Re-analysing…" : "Re-analyse"}
          </button>
        </div>
        <TechnicalDetails failures={failures} />
      </div>
    </div>
  )
}
