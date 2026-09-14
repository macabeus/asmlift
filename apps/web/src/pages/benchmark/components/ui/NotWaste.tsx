/** The sentence every cost view carries. A cost number alone reads as an indictment of the variation
 *  it is next to; a losing candidate is what the winner was measured against. */
export function NotWaste() {
  return (
    <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-200/80">
      <span className="font-medium text-amber-200">A losing candidate is not waste.</span> It is the control the winner
      was scored against: without the <span className="font-mono">raw-globals</span> candidates, nothing shows that the
      named-globals spelling was better. A high price per win says where to look, never what to delete.
    </p>
  );
}
