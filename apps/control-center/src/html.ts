// Escaping HTML builder. Ticket titles, review text and branch subjects are written by agents and
// are untrusted, so every interpolated value is escaped unless it is already built `Html`.

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export type Html = { readonly html: string };

/** Marks trusted markup (only ever literal strings in this codebase) as already safe. */
export const raw = (html: string): Html => ({ html });

/** Tagged template that escapes every interpolated value unless it is already `Html`. */
export function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  return raw(out);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(render).join("");
  }
  if (typeof value === "object" && "html" in value && typeof value.html === "string") {
    return value.html;
  }
  return escapeHtml(String(value));
}

/** A DOM-id-safe key for an untrusted value (ticket numbers, debt ids, run ids). */
export const domKey = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_");
