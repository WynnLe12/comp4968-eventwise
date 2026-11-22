export function normalizeInvitationEmail(value: string): string | undefined {
  const email = value.trim();
  const [local, domain, extra] = email.split("@");
  const dotAtom = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
  const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (email.length > 254 || local.length > 64 || !dotAtom.test(local) || !domain || extra !== undefined || !dnsName.test(domain)) {
    return undefined;
  }
  return email.toLowerCase();
}
