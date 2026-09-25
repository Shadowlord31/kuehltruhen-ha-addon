// Artikelnamen: Leerräume zusammenfassen und für den Vergleich (name_key) klein schreiben.
// "Hack", "hack " und "HACK" sind derselbe Artikel.
function normalizeName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim();
}

function nameKey(name) {
  return normalizeName(name).toLocaleLowerCase('de-DE');
}

module.exports = { normalizeName, nameKey };
