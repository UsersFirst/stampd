import type {Address} from "@stampd/shared";

/// Everyone a single `mintBatch` should badge.
///
/// The pending address — the one just scanned or typed, not yet pressed into the batch — counts
/// as a recipient on its own. That is what makes the default flow two steps rather than three,
/// and it means an organizer working a line who forgets to press "Add" still badges the person in
/// front of them instead of silently skipping them.
///
/// Deduplicates case-insensitively. The contract tolerates a duplicate by skipping it, so this is
/// about not making an organizer stare at the same address twice, not about correctness on-chain.
export function mergeRecipients(queue: readonly Address[], pending: Address | null): Address[] {
    if (!pending) return [...queue];
    const already = queue.some((entry) => entry.toLowerCase() === pending.toLowerCase());
    return already ? [...queue] : [...queue, pending];
}
