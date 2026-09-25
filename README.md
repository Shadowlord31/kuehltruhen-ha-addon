# Kühltruhen-Inventar

Home Assistant Add-on für eine einfache Bestandsübersicht über mehrere Kühltruhen — deutlich schlanker als Grocy.

## Funktionen

- Produkte anlegen (Name, Einheit, Kategorie) — bleiben dauerhaft im Katalog, auch bei Bestand 0
- Bestand pro Standort (Truhe) führen — ein Produkt kann an mehreren Standorten liegen
- Einlagern / Entnehmen direkt am jeweiligen Standort, sodass Entnahmen nie am falschen Ort abgebucht werden
- Standorte frei verwaltbar (Truhen anlegen, umbenennen, löschen – nur ohne Bestand)
- Kategorien zur Gruppierung der Übersicht (z. B. Fleisch, Beilagen, Gemüse), im UI verwaltbar (⚙ Verwalten)
- Filter nach Standort und Kategorie, Suche
- Große, touchfreundliche Oberfläche; ab Tablet-Breite mehrspaltige Produktliste
- Bewegungsprotokoll (global und pro Produkt) mit Rückgängig-Funktion für Ein- und Entnahmen
- MHD-Warnung: Badges in Übersicht und Detail, Hinweisband mit Filter „nur Warnungen“; Schwelle einstellbar (Add-on-Option `mhd_warntage`, Standard 7 Tage)
- Mindestbestand pro Produkt (über alle Truhen): Badge, Hinweisband mit Filter „nur Warnungen“, einstellbar beim Anlegen und im Produktdetail
- Umlagern zwischen Truhen: MHD, Notiz und Einlagerdatum bleiben erhalten, im Protokoll eine Zeile („Truhe 1 → Truhe 2“), als Ganzes rückgängig machbar
- Inventurmodus pro Truhe: Ist-Mengen zählen, gebucht werden nur die Abweichungen (als „Inventur“ im Protokoll, einzeln rückgängig machbar)

## Technik

- Node.js / Express
- better-sqlite3 (Datei unter `/data/kuehltruhen.db`, HA-persistent)
- Ingress (kein eigener Port/Login nötig, läuft im HA-Frontend)

## Installation in Home Assistant

1. *Einstellungen → Add-ons → Add-on-Store → ⋮ → Repositories*
2. `https://github.com/Shadowlord31/kuehltruhen-ha-addon` hinzufügen
3. „Kühltruhen-Inventar" installieren, starten, „In Seitenleiste anzeigen" aktivieren

## Datensicherheit

- **Migrationen** (Schema-Änderungen bei Updates) sind ausschließlich additiv und laufen als Ganzes oder gar nicht. Schlägt etwas fehl, bleibt die Datenbank unverändert und das Add-on startet nicht.
- **Automatische Sicherung** vor jeder Migration bestehender Daten: `backups/pre-migration-…db` im Datenordner des Add-ons (Teil der normalen Home-Assistant-Backups). Es werden die letzten 5 aufbewahrt.
- **Schutz vor Doppelanlage und Doppelbuchung:** Jede schreibende Aktion trägt eine eindeutige Vorgangs-ID. Bei einem Hänger von Home Assistant (Timeout, Fehler 502/503/504) bleibt die ID erhalten – erneutes Tippen führt die Aktion höchstens einmal aus. Während eine Anfrage läuft, sind alle Bedienelemente gesperrt (Fortschrittsbalken oben). Eingaben im Formular „Neues Produkt“ bleiben nach einem Fehler erhalten.
- **Artikelnamen sind eindeutig** (ohne Beachtung von Groß-/Kleinschreibung und überzähligen Leerzeichen). Legt man einen vorhandenen Namen an, erscheint ein Hinweis mit Link zum vorhandenen Artikel.
- **Eindeutige IDs:** Jeder Datensatz (Artikel, Standorte, Kategorien, Bestände, Bewegungen) hat zusätzlich zur Nummer eine UUID.
- **Wiederherstellen:** Add-on stoppen, die gewünschte Sicherung als `kuehltruhen.db` in den Datenordner des Add-ons kopieren (auf HA OS typischerweise unter `/mnt/data/supervisor/addons/data/…`), Add-on starten. Alternativ das komplette HA-Backup des Add-ons einspielen.

## Entwicklung lokal

```bash
cd app
npm install
npm start
```

Standardmäßig läuft der Server dann auf Port 8099, Datenbankdatei landet in `./app/data/kuehltruhen.db`.

> Hinweis: Im Frontend werden API-Pfade bewusst **relativ** (`api/...`) aufgerufen, damit die App auch hinter dem Ingress-Pfad von Home Assistant funktioniert.

## Status

MVP im Aufbau: Produkte, Standorte, Kategorien, Ein-/Auslagerung, Protokoll mit Undo, MHD-Warnung, Mindestbestand, Umlagern, Inventurmodus. Alle im Auftrag vorgesehenen Funktionen sind umgesetzt.

## Tests

```bash
cd app
npm test
```

Startet den Server mit einer temporären Datenbank und prüft die API (Ein-/Entnahme, Protokoll, Undo, MHD, Mindestbestand, Umlagern, Inventur, Migration aus Alt-Datenbanken mit Doppelten, Sicherungen, Vorgangs-IDs, Namenssperre).
