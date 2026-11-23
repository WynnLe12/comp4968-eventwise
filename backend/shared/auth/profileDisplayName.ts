export function normalizeProfileDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(value)) return undefined;
  const name = value.trim();
  return name && name.length <= 256 ? name : undefined;
}

export function profileDisplayName(attributes: readonly { Name?: string; Value?: string }[]): string | undefined {
  const nameAttribute = (key: string) => {
    const matches = attributes.filter(attribute => attribute.Name === key);
    return matches.length === 1 ? normalizeProfileDisplayName(matches[0].Value) : undefined;
  };
  return nameAttribute("name") ?? normalizeProfileDisplayName(
    [nameAttribute("given_name"), nameAttribute("family_name")].filter(Boolean).join(" "),
  );
}
