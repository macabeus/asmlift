/** A link into the benchmark's URL state is a real `href`, so middle-click and copy-link work. A plain
 *  left click is taken over and sent through `follow` (a nuqs write), which updates the view without
 *  a navigation; any modified click keeps the browser's own handling of the `href`. */
export function followInPlace(e: React.MouseEvent, follow: () => void): void {
  if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    follow();
  }
}
