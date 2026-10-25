export type StudentRecord = {
  recordKey: string;
  studentNumber: string;
  displayName: string;
  profileUrl?: string;
  fields: Record<string, string>;
};

export type EmisListRow = {
  fields: Record<string, string>;
  profileUrl?: string;
};

export type EmisPageScan = {
  type: "emis-page-scan";
  pageUrl: string;
  pageTitle: string;
  pageKind: "list" | "detail" | "unknown";
  fields: Record<string, string>;
  rows: EmisListRow[];
  profileLinks: string[];
  nextPageUrls: string[];
};

export function normalizeFieldName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function valueForField(fields: Record<string, string>, ...patterns: string[]): string {
  const entries = Object.entries(fields);
  for (const pattern of patterns) {
    const target = normalizeFieldName(pattern);
    const found = entries.find(([key]) => normalizeFieldName(key).includes(target));
    if (found?.[1]) return found[1];
  }
  return "";
}

const REQUIRED_FIELD_ALIASES: Record<string, string[]> = {
  "اسم الأم": ["اسم الأم", "اسم الام", "اسم الوالدة"],
  "الاسم الرباعي": ["الاسم الرباعي", "الاسم الرابع", "اسم الرابع", "الاسم الكامل", "اسم الكامل", "اسم الطالب الكامل", "الاسم الكامل للطالب", "اسم التلميذ الرباعي"],
  "اللقب": ["اللقب", "اسم العائلة", "العائلة"],
};

export function requiredFieldValue(fields: Record<string, string>, canonicalName: string): string {
  return valueForField(fields, ...(REQUIRED_FIELD_ALIASES[canonicalName] ?? [canonicalName]));
}

export function isRequiredStudentField(fieldName: string): boolean {
  const normalized = normalizeFieldName(fieldName);
  return Object.values(REQUIRED_FIELD_ALIASES).some((aliases) =>
    aliases.some((alias) => normalized.includes(normalizeFieldName(alias))),
  );
}

function exactField(fields: Record<string, string>, ...names: string[]): string {
  const wanted = names.map((name) => normalizeFieldName(name));
  for (const [key, value] of Object.entries(fields)) {
    if (value && wanted.includes(normalizeFieldName(key).replace(/\*/g, "").trim())) return value;
  }
  return "";
}

/** The EMIS form stores the name in separate boxes; join them when no full name field was read. */
function composeFullName(fields: Record<string, string>): string {
  return [
    exactField(fields, "الاسم", "الإسم", "اسم الطالب"),
    exactField(fields, "اسم الأب", "إسم الأب"),
    exactField(fields, "اسم والد الأب", "اسم جد الطالب", "اسم الجد"),
    exactField(fields, "اسم جد الأب"),
  ].filter(Boolean).join(" ");
}

export function makeStudentRecord(
  fields: Record<string, string>,
  profileUrl?: string,
  fallbackKey?: string,
): StudentRecord {
  fields = { ...fields };
  if (!requiredFieldValue(fields, "الاسم الرباعي")) {
    const composed = composeFullName(fields);
    if (composed) fields["الاسم الرباعي"] = composed;
  }
  const studentNumber = valueForField(
    fields,
    "رقم الطالب",
    "الرقم الامتحاني",
    "معرف الطالب",
    "رمز الطالب",
    "student id",
    "student number",
  );
  const displayName = valueForField(
    fields,
    "اسم الطالب",
    "الاسم الرباعي",
    "الاسم الرابع",
    "اسم الرابع",
    "اسم التلميذ",
    "student name",
    "الاسم",
  ) || requiredFieldValue(fields, "الاسم الرباعي") || Object.values(fields).find((value) => value.trim()) || "سجل طالب";
  const recordKey = profileUrl || fallbackKey || studentNumber || `name:${normalizeFieldName(displayName)}`;
  return {
    recordKey,
    studentNumber,
    displayName,
    profileUrl,
    fields: { ...fields },
  };
}

export function mergeStudentRecords(
  current: StudentRecord[],
  incoming: StudentRecord[],
): StudentRecord[] {
  const merged = new Map<string, StudentRecord>();
  for (const record of current) merged.set(record.recordKey, record);
  for (const record of incoming) {
    const existing = Array.from(merged.values()).find((item) => {
      if (item.recordKey === record.recordKey) return true;
      if (record.profileUrl && item.profileUrl) return record.profileUrl === item.profileUrl;
      if (record.recordKey.startsWith("row:") && item.recordKey.startsWith("row:")) return false;
      return Boolean(record.studentNumber && item.studentNumber && record.studentNumber === item.studentNumber);
    });
    const matchKey = existing?.recordKey ?? record.recordKey;
    const previous = merged.get(matchKey);
    merged.set(matchKey, previous
      ? {
          ...previous,
          ...record,
          recordKey: matchKey,
          studentNumber: record.studentNumber || previous.studentNumber,
          displayName: record.displayName || previous.displayName,
          profileUrl: record.profileUrl || previous.profileUrl,
          fields: { ...previous.fields, ...record.fields },
        }
      : { ...record, recordKey: matchKey });
  }
  return Array.from(merged.values()).sort((a, b) => a.displayName.localeCompare(b.displayName, "ar"));
}
