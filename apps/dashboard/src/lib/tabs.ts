export type Tab = "create" | "scan" | "all";

/// Which tab to actually render, given what the organizer last picked and whether they have
/// anything to scan against.
///
/// Derived on every render rather than corrected in an effect. Switching to a wallet that signs
/// for nothing must not leave "Scan attendee" selected with an empty screen behind it, and an
/// effect that fixes it afterwards renders the broken state first.
///
/// Create event and All events are always reachable. All events lists the whole contract, so it
/// is useful to someone who has never created one — which is the case that was previously shown
/// no tab bar at all.
export function resolveTab(chosen: Tab | null, canScan: boolean): Tab {
    if (chosen && (chosen !== "scan" || canScan)) return chosen;
    // Badging by default when it is available: creating an event happens once at a desk, while
    // badging happens repeatedly and is what someone opening this at a door came to do.
    return canScan ? "scan" : "create";
}
