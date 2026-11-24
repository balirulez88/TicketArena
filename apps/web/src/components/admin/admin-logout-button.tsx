/** A plain form POST, like the login: the route clears the cookie and redirects to the login page. */
export function AdminLogoutButton() {
  return (
    <form method="post" action="/api/admin/logout">
      <button type="submit" className="rounded-md border px-4 py-2 font-medium text-sm">
        Log out
      </button>
    </form>
  );
}
