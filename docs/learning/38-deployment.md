# 38: Deployment

Ticket: `issues/38-deployment.md`. Commit: még nincs (a `devflow/run-*` ág working tree-je). ADR: nincs új; az [ADR 0013](../adr/0013-deployment-topology.md) topológiája.

## Probléma

A demónak élőben kell futnia: web a Vercelen, worker és NATS a Fly.io-n, Postgres a Neonon, Redis az Upstashen. A migrációknak minden web deploy előtt le kell futniuk, és a konfigurációt minden app határán validálni kell. Fiókok és titkok nélkül a repóba csak a deployhoz szükséges fájlok és egy emberi lépéssor kerülhet.

## Döntés

1. **Pooled URL a webnek, direct a migrációnak.** A `parseServerEnv` / `parseDatabaseEnv` elutasít minden `*.neon.tech` hostot, amely nem a `-pooler` endpoint, és megnevezi a `DATABASE_URL` mezőt. A driver alapértéke `neon` (`adapter-neon`). A `prisma migrate deploy` session szintű advisory lockot használ, ezért a deploy workflow a `DATABASE_URL_UNPOOLED` direct URL-lel futtatja, és egy shell guard elutasítja a pooled hostot.
2. **Saját deploy workflow** (`.github/workflows/deploy.yml`). A CI sikeres `push` futása után indul a `main` ágon (`workflow_run`), vagy kézzel. A sorrend `gate` → `migrate` → `web` és `worker` (`needs: [gate, migrate]`). A Vercel saját git deployja ki van kapcsolva (`vercel.json`), így nem előzheti meg a migrációt. Ha egy célpont titkai hiányoznak, a job kimarad egy notice-szal, és a `main` zöld marad.
3. **Fly.io, csak privát hálózat.** Egyik `fly.toml`-ban sincs `[http_service]` vagy `[[services]]`. A NATS a `[::]` címen hallgat (a 6PN IPv6), és a worker `nats://ticketarena-nats.internal:4222`-n éri el. A JetStream a `/data`-ra mountolt volume-on tárol, `sync_interval: always` beállítással. A worker `/health`-jét a Fly check hívja, és csak egy gép fut (`--ha=false`).
4. **Konzisztencia-teszt a konfigfájlokra.** A `deploy-config.test.ts` (worker és web) rögzíti a volume–`store_dir` egyezést, a `sync_interval` értékét, a publikus service hiányát, a NATS app nevét a worker URL-jében, a job-sorrendet és a `vercel.json` beállításait. A worker `[env]`-jét mintatitkokkal a `parseWorkerEnv` validálja.

## Alternatívák

| Alternatíva                             | Előny                     | Hátrány                                       | Miért nem itt                                       |
| --------------------------------------- | ------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Vercel git auto-deploy + külön migráció | Nincs Vercel CLI a CI-ben | A deploy megelőzheti a migrációt (race)       | A spec szerint a migráció a web deploy előtt fut    |
| `push` trigger CI nélkül                | Egyszerűbb                | Piros commit is kimehet élesbe                | `workflow_run` csak sikeres CI után indul           |
| Hiányzó titoknál piros job              | Azonnal látszik           | A `main` piros a setup előtt és forkokon      | A notice + skip könnyen visszafordítható            |
| Publikus NATS tokennel                  | Bárhonnan elérhető        | Támadási felület, TLS és auth kezelése        | A worker ugyanabban a Fly szervezetben fut          |
| Upstash REST adapter a queue-hoz most   | Pontosan az ADR 0013      | A REST hibák még nem `SERVICE_UNAVAILABLE`-ök | Follow-up; a node-redis `rediss://` már tesztelt út |

## Fogalmak

- **Pooled vs direct connection**: a Neon PgBouncer (transaction mode) sok rövid kapcsolatot oszt meg, a direct endpoint egy valódi Postgres session.
- **Advisory lock**: alkalmazás által definiált Postgres zár. A session szintű zár a pooleren át nem marad ugyanazon a sessionön.
- **6PN / `.internal`**: a Fly szervezet privát IPv6 hálózata, és a hozzá tartozó belső DNS.
- **`workflow_run`**: egy másik workflow befejezésére induló GitHub Actions trigger.
- **Expand/contract migráció**: először csak bővítünk, és a régi oszlopot egy későbbi deployban távolítjuk el, így a futó régi kód sem törik el.

## Mi mehet félre

| Hibamód                           | Teszt / védelem                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A web a direct Neon URL-t kapja   | `env.test.ts`: "names DATABASE_URL when it is a direct Neon endpoint instead of the pooled one"                        |
| A web deploy a migráció előtt fut | `deploy-config.test.ts`: "deploys the web app and the worker only after the migrations succeeded"; `vercel.json` teszt |
| A migráció a pooled URL-t kapja   | a `migrate` job shell guardja; a teszt a `DATABASE_URL_UNPOOLED` használatát rögzíti                                   |
| A JetStream nem a volume-on tárol | "keeps the JetStream store on the mounted Fly volume"                                                                  |
| A NATS publikus lesz              | "listens on the IPv6 private network and has no public service"                                                        |
| A worker rossz NATS hostot kap    | "reaches NATS over the private network by the NATS app's name"                                                         |

## Interjúkérdések

1. **Miért nem a Vercel git integrációja deployol?** Mert az a migrációval párhuzamosan futna. A workflow-ban a `needs: [gate, migrate]` sorrendet garantál, a `vercel deploy --prebuilt` pedig pontosan azt a commitot telepíti, amelyen a CI átment.
2. **Miért kell a migrációnak direct URL?** A `prisma migrate deploy` session szintű advisory lockkal zárja ki a párhuzamos migrációt. Transaction-mode poolerrel a lock és a lekérdezések különböző szerver-sessionökre kerülhetnek.
3. **Miért csak egy worker gép?** Az admission ticker és a reaper egyetlen workerre épül (ADR 0013). Egy második relay csak duplikált publisht okozna, amit a fogyasztóknak kellene kiszűrniük.
4. **Mi történik, ha a NATS kiesik?** Az outbox sorok `PENDING`-ben maradnak a Postgresben, és a relay újrapróbálja őket. Az ülőhelyről nem a NATS dönt, ezért oversell nem történhet, csak a fizetés és az értesítés késik.
5. **Hogyan marad zöld a `main` titkok nélkül?** A `gate` job envből ellenőrzi a titkokat (a `secrets` nem használható közvetlenül `if:`-ben), és a hiányzó célpont jobja `skipped` lesz, nem `failed`.
