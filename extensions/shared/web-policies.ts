export interface PublicHttpUrlPolicyResult {
	allow: boolean;
	reason: string;
	url?: URL;
}

export function publicHttpUrlBlockReason(hostname: string): string | undefined {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return "local hostnames are blocked";
	if (!host.includes(".") && !host.includes(":")) return "single-label hostnames are blocked as likely local network names";

	const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
	if (ipv4) {
		const octets = ipv4.slice(1).map(Number);
		if (octets.some((octet) => octet < 0 || octet > 255)) return "invalid IPv4 host";
		const [a, b] = octets;
		if (a === 0 || a === 10 || a === 127) return "local/private IPv4 ranges are blocked";
		if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT IPv4 ranges are blocked";
		if (a === 169 && b === 254) return "link-local IPv4 ranges are blocked";
		if (a === 172 && b >= 16 && b <= 31) return "private IPv4 ranges are blocked";
		if (a === 192 && b === 168) return "private IPv4 ranges are blocked";
		if (a >= 224) return "multicast/reserved IPv4 ranges are blocked";
	}

	if (host === "::" || host === "::1") return "local IPv6 ranges are blocked";
	if (/^(?:f[cd][0-9a-f]*|fe80):/i.test(host)) return "private/link-local IPv6 ranges are blocked";

	return undefined;
}

export function validatePublicHttpUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("Invalid URL.");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http:// and https:// URLs are allowed.");
	}

	const localReason = publicHttpUrlBlockReason(url.hostname);
	if (localReason) throw new Error(localReason);
	return url;
}

export function evaluatePublicHttpUrl(rawUrl: unknown): PublicHttpUrlPolicyResult {
	if (typeof rawUrl !== "string" || !rawUrl.trim()) return { allow: false, reason: "URL is unclear" };

	try {
		const url = validatePublicHttpUrl(rawUrl);
		return { allow: true, reason: "public HTTP(S) URL", url };
	} catch (error) {
		return { allow: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
