function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function buildSocketPolicy(gamePort: number, domains: readonly string[]): string {
    const safePort = Math.max(1, Math.min(65535, Math.round(gamePort)));
    const safeDomains = Array.from(new Set(domains.map((domain) => domain.trim()).filter(Boolean)));
    const accessRules = safeDomains
        .map((domain) => `  <allow-access-from domain="${escapeXmlAttribute(domain)}" to-ports="${safePort}" secure="false"/>`)
        .join('\n');

    return `<?xml version="1.0"?>
<!DOCTYPE cross-domain-policy SYSTEM
  "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">
<cross-domain-policy>
${accessRules}
</cross-domain-policy>\0`;
}
