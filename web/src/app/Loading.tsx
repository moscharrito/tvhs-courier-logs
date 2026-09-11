/* Three-dot loading indicator. `full` centres it in the viewport for the
   first load; otherwise it sits inline where content will appear. Matches
   the static loader in index.html that shows before React mounts. */

export function Loading({ full = false, label = 'Loading' }: { full?: boolean; label?: string }) {
    const dots = (
        <div className="tag-loader" role="status" aria-live="polite" aria-label={label}>
            <span /><span /><span />
        </div>
    );
    return full ? <div className="tag-loader-full">{dots}</div> : dots;
}
