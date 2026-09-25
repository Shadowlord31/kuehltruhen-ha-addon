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
- Inventurmodus pro Truhe: Ist-Mengen zählen, gebucht werden nur die Abweichungen (als „Inventur“ im Protokoll, einzeln rückgängig machbar)

## Technik

- Node.js / Express
- better-sqlite3 (Datei unter `/data/kuehltruhen.db`, HA-persistent)
- Ingress (kein eigener Port/Login nötig, läuft im HA-Frontend)

## Installation in Home Assistant

1. *Einstellungen → Add-ons → Add-on-Store → ⋮ → Repositories*
2. `https://github.com/Shadowlord31/kuehltruhen-ha-addon` hinzufügen
3. „Kühltruhen-Inventar" installieren, starten, „In Seitenleiste anzeigen" aktivieren

## Entwicklung lokal

```bash
cd app
npm install
npm start
```

Standardmäßig läuft der Server dann auf Port 8099, Datenbankdatei landet in `./app/data/kuehltruhen.db`.

> Hinweis: Im Frontend werden API-Pfade bewusst **relativ** (`api/...`) aufgerufen, damit die App auch hinter dem Ingress-Pfad von Home Assistant funktioniert.

## Status

MVP im Aufbau: Produkte, Standorte, Kategorien, Ein-/Auslagerung, Protokoll mit Undo, MHD-Warnung, Inventurmodus. Alle im Auftrag vorgesehenen Funktionen sind umgesetzt.

## Tests

```bash
cd app
npm test
```

Startet den Server mit einer temporären Datenbank und prüft die API (Ein-/Entnahme, Protokoll, Undo, MHD, Inventur).
