# 66: Notification send a tranzakción kívül

Ticket: `issues/66-notification-send-outside-the-transaction.md` · commit: még nincs (`devflow/run-202611241838` ág) · ADR: [0009](../adr/0009-per-service-schemas.md) (a `notification` séma külön, a handler ezt írja), a ticket a TD-051 hátralévő részét zárja

## Probléma

A Notification service minden végső order-kimenetről értesítést küld (EMAIL, és SMS, ha van telefonszám). Eddig a `provider.send` a consumer runner tranzakcióján belül futott. Egy lassú provider így egy pool-kapcsolatot tartott lefoglalva. Ha a hívás hosszabb volt az interaktív tranzakció timeoutnál, a tranzakció visszagörgetődött, az üzenet újra érkezett, és ez a végtelenségig ismétlődhetett. A vevő nem kapott értesítést, a rendszer pedig csak terhelte a providert.

## Döntés

A handler három lépésre bomlik, és a provider hívás egyik tranzakcióban sincs (`notification-handler.ts`). A `createNotificationHandler` már `{ beforeTransaction, handler }` párt ad vissza, amelyet a `consumers.ts` mind az öt consumerbe szétterít.

1. **Pending** (`beforeTransaction`): csatornánként külön, rövid írással `PENDING` sor jön létre, vagy a korábbi delivery által hagyott sor folytatódik. A már `SENT` csatornát kihagyja.
2. **Send** (`beforeTransaction`, nincs nyitott tranzakció): `provider.send`, `idempotencyKey = notification id`.
3. **Record** (`handler`, a runner tranzakciója a `processed_messages` dedupe sorral): az esemény összes `PENDING` sora `SENT` lesz.

A helyességet az adja, hogy a `SENT` ugyanabban a commitban jelenik meg, mint a dedupe sor. Ha bármi összeomlik a send és ez a commit között, az üzenet újra érkezik, a `PENDING` sorok megvannak, és a provider ugyanazzal a kulccsal újra megkapja a küldést. A külső kézbesítés így at-least-once, a duplikációt a provider kulcs-dedupe-ja nyeli el, nem a mi kódunk. A `(sourceEventId, channel)` unique megakadályozza a második rekordot. A `beforeTransaction` hookot a ticket 44 már bevezette a fizetéshez; itt csak a szerződés szövege bővült: írhat saját rövid tranzakciót, de a dedupe sort soha.

Tudatos kompromisszum (a `.devflow/questions.md` szerint ez még nyitott kérdés): ha az SMS küldése elbukik az EMAIL után, mindkét sor `PENDING` marad, és az újraküldés az EMAIL-t is újra felajánlja. Ez ártalmatlan, mert a kulcs ugyanaz.

## Alternatívák

| Alternatíva                                      | Előny                                           | Hátrány                                                             | Miért nem itt                                                               |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Send a tranzakción belül (előző állapot)         | Egyszerű, minden egy commit                     | Pool-kapcsolat foglalt, timeout után végtelen redelivery            | Pont ezt javítja a ticket                                                   |
| Timeout megemelése                               | Egy sor config                                  | A kapcsolat így is foglalt marad, a lassabb provider újra átlépi    | Nem szünteti meg az okot, csak eltolja                                      |
| Transactional outbox + külön sender              | Teljes szétválasztás, retry/backoff a sendernek | Új tábla, poller, működtetés: új keretrendszer                      | A ticket MVP-hatóköre tiltja az új frameworköt, a fizetésnél is a hook volt |
| SENT rögzítése csatornánként azonnal a send után | Kevesebb ismételt küldés                        | Újabb írások a send-ek között, a crash-ablak csatornánként megmarad | A provider dedupe úgyis fedez; az egy commit egyszerűbb (feltételezés)      |

## Fogalmak

- **Interaktív tranzakció timeout**: a Prisma `$transaction` ideje; ha lejár, visszagörgeti a tranzakciót. Itt a runner kliensén injektálható (`transaction: { timeoutMs }`).
- **At-least-once**: az üzenet legalább egyszer megérkezik, de többször is érkezhet. Ezért kell az idempotens fogadó.
- **Idempotency key**: a hívó által adott azonosító, amelyre a fogadó ugyanazt a hatást adja ismétlésre is. Itt a notification id.
- **`PENDING` rekord**: a szándék tartós nyoma. A crash után ebből tudja a redelivery, mit kell folytatni.
- **Dedupe sor (`processed_messages`)**: a runner ezzel ismeri fel az újra érkezett üzenetet; a `SENT` update ugyanabban a tranzakcióban commitol.

## Mi mehet félre

| Hibamód                                                   | Teszt (`notification-handler.test.ts`)                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Lassú provider (900 ms) túllépi a 500 ms timeoutot        | `sends and records every channel on the first delivery ...`: egy `ack`, mindkét sor `SENT`                                          |
| A send alatt mégis nyitva van egy tranzakció              | `holds no database transaction open while the provider sends`: `pg_stat_activity` `xact_start`, `[0, 0]`                            |
| Crash a send után, a rögzítés előtt: elveszett vagy dupla | `a crash after the send but before the outcome is recorded ...`: `nak`, majd `ack`, a provider egy kézbesítést rögzít csatornánként |
| A meglévő viselkedés romlik                               | A korábbi tesztek és az AT-43 változatlanul futnak az új `...createNotificationHandler` alakkal                                     |

A crash-t a teszt úgy szimulálja, hogy a runner Prisma kliensének első `$transaction` hívása hibázik (adatbázis-határ), nem úgy, hogy megöl egy folyamatot.

## Interjúkérdések

1. **Miért ne legyen külső hívás adatbázis-tranzakcióban?** A tranzakció a hívás idejére lefoglal egy pool-kapcsolatot, és a hívás időtartama nem a mi kezünkben van. Nálunk a timeoutot túllépő provider végtelen redeliveryt okozott volna.
2. **Hogyan lesz mégis pontosan egyszeri a hatás?** Nem lesz: a küldés at-least-once. A hatás a notification id idempotency key-jén és a provider dedupe-ján múlik, a teszt ugyanazt a kulcsot látja kétszer, de egy kézbesítést rögzít.
3. **Mi történik, ha a send és a `SENT` commit között összeomlik a worker?** A `PENDING` sor és a nem commitolt dedupe sor miatt az üzenet újra érkezik, újraküld, majd rögzít. A teszt `nak` után `ack`-et vár.
4. **Miért maradt meg a dedupe sor a runnernél, és nem a `beforeTransaction`-ben van?** A dedupe döntés csak a `SENT` rögzítéssel együtt lehet atomikus. A hook ezért írhat rövid saját sort, a dedupe sort soha.
5. **Mit tennél, ha a provider nem támogatna idempotency key-t?** Ez általános tudás, nem e projekt kódja: outbox plusz egy sender, amely a küldés előtt foglalja a kulcsot, és a duplikációt elfogadja vagy a providertől kéri el az állapotot.
