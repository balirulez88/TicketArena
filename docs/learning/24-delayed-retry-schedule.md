# 24: Késleltetett retry ütemezés

Ticket: `issues/24-delayed-retry-schedule.md`. Commit: még nincs (munkafában). ADR: [0011](../adr/0011-delivery-retry-dlq-recovery.md).

## Probléma

Ha egy consumer handlere átmenetileg hibázik (pl. a provider timeoutol), az üzenetet később újra kell próbálni. Azonnal nem érdemes: a hibás függőség még nem állt helyre, és a retry vihar csak terheli. Soha nem próbálni sem szabad: az ADR 0011 elve szerint az újrafeldolgozás elfogadható, a feldolgozatlan üzenet csendes eldobása nem.

## Decision

1. **Mindig késleltetett `nak`.** A runner minden sikertelen kézbesítést `nak(delayMs)`-szel zár. Egy paraméter nélküli `nak` a JetStreamben azonnal újraszállít, ez lenne az "azonnali retry" hiba (`consumer-runner.ts`, a `nak` előtti komment).
2. **A késleltetést a `deliveryCount` választja**: 1 s, 5 s, 30 s, 2 perc (`RETRY_DELAYS_MS`); a 4. kézbesítés után a 2 perc ismétlődik. A `deliveryCount` a JetStream számlálója, ezért ez az egyetlen attempt counter: a crasheket és az `AckWait` lejáratokat is számolja, és újraindítás után is megvan. Egy processzen belüli számláló ezt elveszítené.
3. **A policy kódban él, nem consumer `BackOff`-ban.** A `BackOff` a szerver konfigjába kötné az időzítést és felülírja az `AckWait`-et (ADR 0011).
4. **Hosszú handler `working()`-et hív**, hogy az `AckWait` ne járjon le, és az üzenetet ne kapja meg egy másik worker.

A kulcsötlet: a retry időzítése a brokernél van (a `nak` késleltet), az attempt száma is a brokertől jön, így a runner állapotmentes és crash-biztos.

Nyitott kérdés (`.devflow/questions.md`, nincs megválaszolva): a 4. kézbesítés után a 2 perc ismétlődik; a retry végét a ticket 25 DLQ kapuja (`deliveryCount > 5`) adja majd, és nem ez a tábla.

## Alternatívák

| Alternatíva                                    | Előny                         | Hátrány                                                                          | Miért nem itt                                |
| ---------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| Paraméter nélküli `nak`                        | Legegyszerűbb                 | Azonnali redelivery, forró ciklus kiesés alatt                                   | A ticket tiltja az azonnali retryt           |
| Consumer `BackOff`                             | A szerver intézi az ütemezést | Konfigba köti az időzítést, módosítja az `AckWait` szemantikát                   | ADR 0011: a policy egy helyen, kódban legyen |
| Alkalmazásszintű attempt számláló (DB/memória) | Szabadon alakítható           | Nem látja a crasheket és `AckWait` lejáratokat; memóriában újraindításkor elvész | Az ADR egyetlen számlálót ír elő             |
| Finite `MaxDeliver`                            | A szerver dönt a végéről      | A szerver eldobhatja az üzenetet DLQ-másolat nélkül                              | ADR 0011 elveti                              |

## Fogalmak

- **`nak(delay)`**: negatív visszajelzés a brokernek; az üzenet a megadott késleltetés után kerül újra kiszállításra.
- **`deliveryCount`**: a broker által vezetett kézbesítésszám, minden kiszállítást számol (hibát, crasht, lejáratot).
- **`AckWait`**: az idő, ameddig a broker ack-ra vár; utána úgy tekinti, hogy a worker elhalt, és újraszállít.
- **`working()`**: jelzi a brokernek, hogy a handler él, és újraindítja az `AckWait` órát.
- **Backoff**: növekvő várakozás a próbálkozások között, hogy a hibás függőség lélegezhessen.

## Mi romolhat el

| Hiba                                                         | Teszt (`consumer-runner-retry.test.ts`)                                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rossz vagy nem növekvő késleltetés                           | „naks a transient handler failure with 1s, 5s, 30s, 2m…": hat kézbesítés, delay-ek 1 s, 5 s, 30 s, 2 m, 2 m, 2 m (az óra összeomlasztva, a broker a valódi `deliveryCount`-ot adja) |
| A késleltetés nem látszik a logban                           | „logs the chosen delay…": `delayMs: 1000` az `error` soron                                                                                                                          |
| Crash vagy `AckWait` lejárat után a séma elölről indul       | „takes the attempt from deliveryCount alone…": egy félbehagyott kézbesítés után az új runner a 2. és 3. lépést (5 s, 30 s) választja                                                |
| A hosszú handler közben másik worker is megkapja az üzenetet | „lets a long handler call working()…": a rivális fetch üres marad, a `processed_messages` sor megvan                                                                                |
| A valódi broker nem tartja be a késleltetést                 | AT-27: első kézbesítés hibázik, a második legalább 1 s-mal később sikerül                                                                                                           |

## Interjúkérdések

1. **Miért késleltetett `nak`, és nem sima `nak`?** A sima `nak` a JetStreamben azonnal újraszállít, így egy tartósan hibás függőség mellett forró ciklus lenne. A `nak(delay)` a brokerre bízza a várakozást.
2. **Miért a `deliveryCount` az egyetlen számláló?** Mert csak ez számolja a crasheket és `AckWait` lejáratokat is, és újraindítás után is él. Egy saját számláló ezeket nem látná, így egy mindig összeomló üzenet sosem lépne előre a sémán.
3. **Miért nem `BackOff`?** A szerveroldali `BackOff` felülírja az `AckWait`-et, és az időzítést a konfigba rejti. A kódban lévő tábla tesztelhető és egy helyen van (ADR 0011).
4. **Hogyan teszteltétek a perceket átfogó ütemezést?** Egy burkoló bus rögzíti a kért delay-t, és nulla késleltetéssel `nak`-ol. Így ezredmásodpercek alatt látszik a séma, miközben a `deliveryCount` a valódi brokertől jön. Ez a mi határunk (broker) mockolása, nem a saját modulé.
5. **Mire való a `working()`?** Ha a handler hosszabb az `AckWait`-nél, a broker halottnak hinné a workert, és másnak adná az üzenetet. A teszt bizonyítja, hogy a `working()` hívásokkal a rivális worker nem kap semmit.
