import type { AnchorHTMLAttributes } from "react";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & {
  href: string;
};

export function Link({ href, children, ...attributes }: Props) {
  return (
    <a
      {...attributes}
      href={href}
      onClick={(event) => {
        const anchor = event.currentTarget;
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (anchor.target && anchor.target !== "_self") ||
          anchor.hasAttribute("download")
        )
          return;
        const destination = new URL(anchor.href);
        if (destination.origin !== window.location.origin) return;
        event.preventDefault();
        if (destination.href === window.location.href) return;
        window.history.pushState(null, "", destination.href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      {children}
    </a>
  );
}
