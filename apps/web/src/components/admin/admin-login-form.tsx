/** Why the last attempt failed, as the login route reports it in the redirect's query string. */
export type AdminLoginFailure =
  | { readonly kind: "invalid" }
  | { readonly kind: "rate-limited"; readonly retrySeconds: number | null }
  | { readonly kind: "unavailable" };

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** Reads the login route's `error` (and `retry`) parameters; anything unknown shows no error. */
export function loginFailureFrom({ error, retry }: SearchParams): AdminLoginFailure | null {
  switch (error) {
    case "invalid":
      return { kind: "invalid" };
    case "unavailable":
      return { kind: "unavailable" };
    case "rate-limited": {
      const seconds = typeof retry === "string" && /^\d{1,3}$/.test(retry) ? Number(retry) : null;
      return { kind: "rate-limited", retrySeconds: seconds };
    }
    default:
      return null;
  }
}

function failureMessage(failure: AdminLoginFailure): string {
  switch (failure.kind) {
    case "invalid":
      return "Wrong password. Try again.";
    case "rate-limited":
      return failure.retrySeconds === null
        ? "Too many login attempts. Try again shortly."
        : `Too many login attempts. Try again in ${failure.retrySeconds} s.`;
    case "unavailable":
      return "Login is unavailable right now. Try again later.";
  }
}

/**
 * A plain HTML form: it works before (and without) hydration, and the login route answers with a
 * redirect, so there is no client state to manage.
 */
export function AdminLoginForm({ failure }: { readonly failure: AdminLoginFailure | null }) {
  return (
    <form method="post" action="/api/admin/login" className="flex flex-col gap-4">
      <label htmlFor="admin-password" className="font-medium text-sm">
        Admin password
      </label>
      <input
        id="admin-password"
        name="password"
        type="password"
        required
        autoComplete="current-password"
        className="rounded-md border px-3 py-2"
      />
      {failure === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {failureMessage(failure)}
        </p>
      )}
      <button
        type="submit"
        className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
      >
        Log in
      </button>
    </form>
  );
}
