/// Image moderation via Google Cloud Vision SafeSearch.
///
/// Runs in the Worker, not the browser. `/api/upload` is a public endpoint authorized by a wallet
/// signature — anyone can POST to it directly with curl — so a check in the dashboard would be
/// decoration. This is the only place it can be enforced.
///
/// Workers AI was the first choice, since it would have added no vendor. Its catalogue has no
/// image moderation model: `resnet-50` classifies ImageNet categories, `llama-guard-3-8b` is
/// text-only, and the NSFW filter that exists applies to prompts going *into* image generation
/// rather than to classifying an uploaded image. Prompting a vision LLM would work but returns an
/// uncalibrated yes/no instead of graded likelihoods, at higher latency and cost.

/// Google's five-point scale, in order. The index is the score stored in D1.
const LIKELIHOOD = ["UNKNOWN", "VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY"] as const;

export interface SafeSearchScores {
    adult: number;
    racy: number;
    violence: number;
    medical: number;
    spoof: number;
}

export interface ModerationResult {
    verdict: "allow" | "reject";
    scores: SafeSearchScores;
    /// Which categories crossed their threshold. Empty when allowed.
    reasons: string[];
}

export interface ModerationThresholds {
    adult: number;
    racy: number;
    violence: number;
}

/// Defaults chosen to refuse what would embarrass an organizer without refusing a beach photo.
/// `racy` sits a notch higher than the others deliberately: it fires on swimwear and close-ups,
/// and a false rejection at this stage is silent — the organizer sees only that their upload was
/// refused, with no way to appeal it.
export const DEFAULT_THRESHOLDS: ModerationThresholds = {
    adult: 4, // LIKELY
    racy: 5, // VERY_LIKELY
    violence: 4, // LIKELY
};

function score(value: unknown): number {
    const index = LIKELIHOOD.indexOf(String(value) as (typeof LIKELIHOOD)[number]);
    return index < 0 ? 0 : index;
}

export function describeScore(value: number): string {
    return LIKELIHOOD[value] ?? "UNKNOWN";
}

/// Calls SafeSearch. Throws on transport or API failure — the caller decides what an unreachable
/// moderator means, because that is a policy question rather than a technical one.
export async function classifyImage(
    bytes: ArrayBuffer,
    apiKey: string,
    thresholds: ModerationThresholds,
): Promise<ModerationResult> {
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
            requests: [
                {
                    image: {content: base64(bytes)},
                    features: [{type: "SAFE_SEARCH_DETECTION"}],
                },
            ],
        }),
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        throw new Error(`Vision API returned ${response.status}`);
    }

    const body = (await response.json()) as {
        responses?: Array<{
            safeSearchAnnotation?: Record<string, string>;
            error?: {message?: string};
        }>;
    };

    const first = body.responses?.[0];
    if (first?.error) throw new Error(first.error.message ?? "Vision API error");

    const annotation = first?.safeSearchAnnotation;
    // A missing annotation is not an implicit pass. Treat it as a failure so the caller applies
    // its fail-closed policy rather than admitting an unscored image.
    if (!annotation) throw new Error("Vision API returned no annotation");

    const scores: SafeSearchScores = {
        adult: score(annotation.adult),
        racy: score(annotation.racy),
        violence: score(annotation.violence),
        medical: score(annotation.medical),
        spoof: score(annotation.spoof),
    };

    const reasons: string[] = [];
    if (scores.adult >= thresholds.adult) reasons.push("adult");
    if (scores.racy >= thresholds.racy) reasons.push("racy");
    if (scores.violence >= thresholds.violence) reasons.push("violence");

    return {verdict: reasons.length > 0 ? "reject" : "allow", scores, reasons};
}

/// Chunked to stay clear of the argument limit on `String.fromCharCode` — a 5 MB upload is well
/// past what a single spread call survives.
function base64(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes);
    let binary = "";
    for (let i = 0; i < view.length; i += 0x8000) {
        binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export function thresholdsFrom(env: {
    MODERATION_THRESHOLD_ADULT?: string;
    MODERATION_THRESHOLD_RACY?: string;
    MODERATION_THRESHOLD_VIOLENCE?: string;
}): ModerationThresholds {
    const read = (raw: string | undefined, fallback: number) => {
        const parsed = Number(raw);
        return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : fallback;
    };
    return {
        adult: read(env.MODERATION_THRESHOLD_ADULT, DEFAULT_THRESHOLDS.adult),
        racy: read(env.MODERATION_THRESHOLD_RACY, DEFAULT_THRESHOLDS.racy),
        violence: read(env.MODERATION_THRESHOLD_VIOLENCE, DEFAULT_THRESHOLDS.violence),
    };
}
