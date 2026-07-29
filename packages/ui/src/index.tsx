import type {
  ButtonHTMLAttributes,
  FormEventHandler,
  ReactNode
} from "react";
import { useId } from "react";

export type ThemeMode = "light" | "dark";
export type ProductRole = "business" | "admin";
export type StatusTone = "neutral" | "success" | "warning" | "info";

export interface NavigationItem {
  id: string;
  label: string;
  path: string;
  marker: string;
}

export interface ShellLinkProps {
  href: string;
  className: string;
  children: ReactNode;
  ariaCurrent?: "page";
  title?: string;
}

export type LinkRenderer = (props: ShellLinkProps) => ReactNode;

export interface AppShellProps {
  role: ProductRole;
  roleLabel: string;
  navigation: readonly NavigationItem[];
  activePath: string;
  theme: ThemeMode;
  onThemeChange: () => void;
  brand: { title: string; subtitle: string; mark: string };
  status: { title: string; detail: string };
  homePath: string;
  renderLink: LinkRenderer;
  accountLabel?: string;
  onLogout?: () => void;
  children: ReactNode;
}

export function AppShell({
  role,
  roleLabel,
  navigation,
  activePath,
  theme,
  onThemeChange,
  brand,
  status,
  homePath,
  renderLink,
  accountLabel,
  onLogout,
  children
}: AppShellProps) {
  return (
    <div className="v2-app-shell" data-role={role}>
      <aside className="v2-sidebar">
        {renderLink({
          href: homePath,
          className: "v2-brand",
          children: <>
            <span className="v2-brand-mark" aria-hidden="true">{brand.mark}</span>
            <span className="v2-brand-copy"><strong>{brand.title}</strong><small>{brand.subtitle}</small></span>
          </>
        })}
        <nav className="v2-primary-nav" aria-label={`${roleLabel} 메뉴`}>
          {navigation.map((item) => {
            const active = activePath === item.path;
            return <span className="v2-nav-slot" key={item.id}>{renderLink({
              href: item.path,
              className: "v2-nav-item",
              ariaCurrent: active ? "page" : undefined,
              children: <>
                <span className="v2-nav-marker" aria-hidden="true">{item.marker}</span>
                <span>{item.label}</span>
              </>
            })}</span>;
          })}
        </nav>
        <div className="v2-sidebar-status" role="status">
          <span className="v2-status-pulse" aria-hidden="true" />
          <div><strong>{status.title}</strong><span>{status.detail}</span></div>
        </div>
      </aside>

      <div className="v2-workspace-frame">
        <header className="v2-topbar">
          <div className="v2-role-context"><span aria-hidden="true" /><strong>{roleLabel}</strong></div>
          <div className="v2-topbar-actions">
            {accountLabel ? <span className="v2-account-context"><strong>{accountLabel}</strong><small>{roleLabel}</small></span> : null}
            <button
              className="v2-icon-button"
              type="button"
              onClick={onThemeChange}
              aria-label={theme === "light" ? "다크 모드로 전환" : "라이트 모드로 전환"}
              title={theme === "light" ? "다크 모드" : "라이트 모드"}
            >
              <span aria-hidden="true">{theme === "light" ? "◐" : "○"}</span>
            </button>
            {onLogout ? <button className="v2-icon-button" type="button" onClick={onLogout} aria-label="로그아웃" title="로그아웃"><span aria-hidden="true">↗</span></button> : null}
          </div>
        </header>
        <main className="v2-workspace" id="main-content">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return <header className="v2-page-header">
    <div><span className="v2-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
    {actions ? <div className="v2-page-actions">{actions}</div> : null}
  </header>;
}

export function StatusBadge({ tone = "neutral", children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className="v2-status-badge" data-tone={tone}>{children}</span>;
}

export function MetricCard({ label, value, detail, tone = "neutral" }: {
  label: string;
  value: string;
  detail: string;
  tone?: StatusTone;
}) {
  return <article className="v2-metric-card" data-tone={tone}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  const titleId = useId();
  return <section className="v2-empty-state" aria-labelledby={titleId}>
    <span className="v2-empty-icon" aria-hidden="true">✓</span>
    <div><strong id={titleId}>{title}</strong><p>{description}</p></div>
    {action ? <div className="v2-empty-action">{action}</div> : null}
  </section>;
}

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet";
}) {
  return <button {...props} className={`v2-button v2-button--${variant} ${className}`.trim()} />;
}

export function AuthPanel({ eyebrow, title, description, icon, footer, children, onSubmit }: {
  eyebrow: string;
  title: string;
  description: string;
  icon: string;
  footer?: ReactNode;
  children: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  return <main className="v2-auth-shell">
    <section className="v2-auth-panel" aria-labelledby="auth-title">
      <header className="v2-auth-brand"><span aria-hidden="true">{icon}</span><div><strong>숙박 데이터랩</strong><small>운영 인사이트</small></div></header>
      <div className="v2-auth-copy"><span className="v2-eyebrow">{eyebrow}</span><h1 id="auth-title">{title}</h1><p>{description}</p></div>
      {onSubmit ? <form className="v2-auth-form" onSubmit={onSubmit}>{children}</form> : <div className="v2-auth-form">{children}</div>}
      {footer ? <footer className="v2-auth-footer">{footer}</footer> : null}
    </section>
  </main>;
}
