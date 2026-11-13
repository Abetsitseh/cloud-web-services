// Durée de vie des machines : conversion, compte à rebours et expiration.

export const TTL_OPTIONS = [
  { value: 0, label: "Illimitée" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 heure" },
  { value: 180, label: "3 heures" },
  { value: 360, label: "6 heures" },
  { value: 720, label: "12 heures" },
  { value: 1440, label: "24 heures" },
  { value: 10080, label: "7 jours" },
];

function nonNegativeMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("La durée doit être un nombre entier positif ou nul");
  }
  return value;
}

export function ttlLabel(minutes) {
  if (minutes === null || minutes === undefined || minutes === "") return "Illimitée";
  const value = nonNegativeMinutes(minutes);
  if (!value) return "Illimitée";
  const option = TTL_OPTIONS.find((item) => item.value === value);
  if (option) return option.label;
  if (value % 1440 === 0) return value / 1440 + " j";
  if (value % 60 === 0) return value / 60 + " h";
  return value + " min";
}

// « 2 j 3 h », « 3 h 12 min », « 4 min 20 s ».
export function formatRemaining(ms) {
  if (ms === null || ms === undefined) return null;
  const remaining = Number(ms);
  if (!Number.isFinite(remaining)) throw new RangeError("La durée restante doit être un nombre fini");
  if (remaining <= 0) return "expirée";
  const total = Math.floor(remaining / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return days + " j " + hours + " h";
  if (hours) return hours + " h " + String(minutes).padStart(2, "0") + " min";
  if (minutes) return minutes + " min " + String(seconds).padStart(2, "0") + " s";
  return seconds + " s";
}

// Date d'expiration d'une machine au moment du déploiement (null si illimitée).
export function expiresAtFrom(ttlMinutes) {
  if (ttlMinutes === null || ttlMinutes === undefined || ttlMinutes === "") return null;
  const minutes = nonNegativeMinutes(ttlMinutes);
  if (!minutes) return null;
  const timestamp = Date.now() + minutes * 60000;
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) {
    throw new RangeError("La durée dépasse la plage de dates prise en charge");
  }
  return new Date(timestamp).toISOString();
}

export function isExpired(expiresAt) {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return false;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) throw new RangeError("La date d'expiration est invalide");
  return timestamp <= Date.now();
}
