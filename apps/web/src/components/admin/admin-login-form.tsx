/**
 * A plain HTML form: it works before (and without) hydration, and the login route answers with a
 * redirect, so there is no client state to manage.
 */
export function AdminLoginForm({ failed }: { readonly failed: boolean }) {
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
      {failed ? (
        <p role="alert" className="text-destructive text-sm">
          Wrong password. Try again.
        </p>
      ) : null}
      <button
        type="submit"
        className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
      >
        Log in
      </button>
    </form>
  );
}
