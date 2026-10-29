// Values the global setup hands to every test file via `provide`/`inject`. Kept in its own
// module so any package that imports the helpers also sees the augmentation.
declare module "vitest" {
  export interface ProvidedContext {
    ticketarenaTemplateDatabase: string;
  }
}

export type ProvidedTemplateDatabase = string;
