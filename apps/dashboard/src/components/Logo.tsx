import {StampdMark, StampdLockup} from "./LogoArt";

/// The logo is inlined rather than loaded as an image so its ink can be `currentColor`.
/// One asset then serves both themes — it simply takes the colour of the text around it.
/// Standalone files with baked colours live in public/ for use outside the app.

interface LogoProps {
    variant?: "mark" | "lockup";
    width: number;
    className?: string;
}

export function Logo({variant = "mark", width, className}: LogoProps) {
    if (variant === "lockup") {
        return <StampdLockup title="stampd — was there" width={width} className={className} />;
    }
    return <StampdMark width={width} className={className} />;
}
