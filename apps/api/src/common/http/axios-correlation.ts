import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { currentTrace } from '../logger/trace-context';

/**
 * Attach the in-flight correlation id as the `x-request-id` header to outbound
 * HTTP calls.
 *
 * IMPORTANT: `@nestjs/axios`'s HttpModule builds a fresh axios instance per
 * module via `axios.create(config)` — and that call happens at module LOAD time
 * (the `HttpModule.register(...)` expression sits inside the `@Module(...)`
 * decorator). Main.ts must therefore import this module BEFORE `AppModule`, so
 * every HttpService instance picks up the interceptor. See `src/main.ts`.
 */
/**
 * True when this request targets the AI service.
 *
 * Compares origins rather than doing a prefix match: a `startsWith` test would
 * also be satisfied by a hostile URL that merely begins with the same string
 * (e.g. `http://ai.internal.evil.com`), which would leak the shared secret.
 */
function isSameOrigin(config: AxiosRequestConfig, base: string): boolean {
  try {
    const target = new URL(config.url ?? '', config.baseURL ?? base);
    return target.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export function installAxiosCorrelation(): void {
  // TS's typed export takes `import axios from 'axios'`; the CJS runtime adds a
  // self-referential `.default`, which @nestjs/axios itself targets. Resolve the
  // same object explicitly so the patch lands where HttpModule creates from.
  const axiosInstance = (axios as unknown as { default: typeof axios }).default;

  const originalCreate = axiosInstance.create.bind(axiosInstance);

  axiosInstance.create = ((config?: AxiosRequestConfig): AxiosInstance => {
    const instance = originalCreate(config);
    instance.interceptors.request.use((requestConfig) => {
      const { requestId } = currentTrace();
      if (requestId && requestId !== '-') {
        requestConfig.headers['x-request-id'] = requestId;
      }
      // Authenticate to the AI service. Done here rather than at each of the
      // ~30 call sites so a new one can't forget it and get a 401 in prod.
      // Scoped to the AI service's own URL so the secret is never attached to
      // an outbound call to a third party (LLM vendors, scrape targets).
      const secret = process.env.INTERNAL_SERVICE_SECRET;
      const aiBase = process.env.AI_SERVICE_URL;
      if (secret && aiBase && isSameOrigin(requestConfig, aiBase)) {
        requestConfig.headers['x-internal-secret'] = secret;
      }
      return requestConfig;
    });
    return instance;
  }) as typeof axiosInstance.create;
}

installAxiosCorrelation();