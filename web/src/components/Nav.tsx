"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
    { href: "/", label: "Dashboard" },
    { href: "/routers", label: "Routers" },
    { href: "/analytics", label: "Analytics" },
    { href: "/explorer", label: "Explorer" },
];

/// Client Component only because it needs `usePathname` to highlight the
/// active link — the rest of the shell stays a Server Component.
export function Nav() {
    const pathname = usePathname();
    return (
        <nav className="nav">
            {LINKS.map(link => {
                const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
                return (
                    <Link key={link.href} href={link.href} className={active ? "active" : ""}>
                        {link.label}
                    </Link>
                );
            })}
        </nav>
    );
}
