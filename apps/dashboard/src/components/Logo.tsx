/// The source artwork is white line art, which disappears on a light background. These are
/// two pre-rendered inks of the same mark, swapped by `prefers-color-scheme` via <picture>,
/// so the logo stays legible in both themes without any JS or CSS filter tricks.

interface LogoProps {
    variant?: "mark" | "lockup";
    width: number;
    className?: string;
}

const ASSETS = {
    mark: {light: "/stampd-mark-light.png", dark: "/stampd-mark-dark.png", ratio: 120 / 128},
    lockup: {light: "/stampd-lockup-light.png", dark: "/stampd-lockup-dark.png", ratio: 463 / 440},
} as const;

export function Logo({variant = "mark", width, className}: LogoProps) {
    const asset = ASSETS[variant];
    return (
        <picture>
            <source srcSet={asset.dark} media="(prefers-color-scheme: dark)" />
            <img
                className={className}
                src={asset.light}
                alt={variant === "lockup" ? "stampd — was there" : ""}
                width={width}
                height={Math.round(width * asset.ratio)}
                decoding="async"
            />
        </picture>
    );
}
