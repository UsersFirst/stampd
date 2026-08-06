import {useCallback, useEffect, useRef, useState, type RefObject} from "react";

/// Google Identity Services, loaded on demand.
///
/// The same approach as the Tandemonium dashboard: GIS hands back an ID token which the Worker
/// verifies against Google's published keys. The difference is that nothing is exchanged for a
/// session — this token *is* the credential, sent as a bearer on operator requests.
///
/// The script is only fetched when someone opens the operator view. An organizer badging
/// attendees at a door should not pay for Google's SDK to sit on a screen they never open.

const GIS_SRC = "https://accounts.google.com/gsi/client";

interface GoogleCredentialResponse {
    credential?: string;
}

interface GoogleAccounts {
    accounts: {
        id: {
            initialize(config: {
                client_id: string;
                callback: (response: GoogleCredentialResponse) => void;
                auto_select?: boolean;
            }): void;
            renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
            prompt(): void;
        };
    };
}

declare global {
    interface Window {
        google?: GoogleAccounts;
    }
}

let scriptPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
    if (window.google?.accounts?.id) return Promise.resolve();
    // One load per page, however many components ask for it.
    scriptPromise ??= new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = GIS_SRC;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Could not load Google Sign-In."));
        document.head.appendChild(script);
    });
    return scriptPromise;
}

/// An ID token expires in about an hour. Re-prompting a little early avoids the operator
/// discovering it lapsed by way of a 401 mid-action.
function expiryOf(token: string): number {
    try {
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as {
            exp?: number;
        };
        return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
    } catch {
        return 0;
    }
}

export interface GoogleAuth {
    /// Where to render Google's own button. Their branding rules require using it rather than a
    /// look-alike, and it also handles the popup and account chooser.
    buttonRef: RefObject<HTMLDivElement>;
    token: string | null;
    email: string | null;
    error: string | null;
    isReady: boolean;
    signOut: () => void;
}

export function useGoogleAuth(clientId: string | undefined): GoogleAuth {
    const buttonRef = useRef<HTMLDivElement>(null);
    const [token, setToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
        if (!clientId) return;
        let cancelled = false;

        loadGis()
            .then(() => {
                if (cancelled || !window.google) return;
                window.google.accounts.id.initialize({
                    client_id: clientId,
                    callback: (response) => {
                        if (!response.credential) {
                            setError("Google returned no credential.");
                            return;
                        }
                        setError(null);
                        setToken(response.credential);
                    },
                });
                if (buttonRef.current) {
                    window.google.accounts.id.renderButton(buttonRef.current, {
                        theme: "outline",
                        size: "large",
                        text: "signin_with",
                    });
                }
                setIsReady(true);
            })
            .catch((caught: unknown) => {
                if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
            });

        return () => {
            cancelled = true;
        };
    }, [clientId]);

    // Drop the token slightly before Google would reject it, so the operator is shown the sign-in
    // button again rather than a failed request.
    useEffect(() => {
        if (!token) return;
        const msLeft = expiryOf(token) - Date.now() - 60_000;
        if (msLeft <= 0) {
            setToken(null);
            return;
        }
        const timer = setTimeout(() => setToken(null), msLeft);
        return () => clearTimeout(timer);
    }, [token]);

    const signOut = useCallback(() => setToken(null), []);

    const email = token
        ? (() => {
              try {
                  const payload = JSON.parse(
                      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
                  ) as {email?: string};
                  return payload.email ?? null;
              } catch {
                  return null;
              }
          })()
        : null;

    return {buttonRef, token, email, error, isReady, signOut};
}
