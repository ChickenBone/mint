import clsx from "clsx";

export function PageHeader({ title, sub, children, art, className }: { title: string; sub?: React.ReactNode; children?: React.ReactNode; art?: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("-mx-6 -mt-14 flex flex-col gap-6 px-6 pt-20 pb-8 sm:flex-row sm:items-end", className)}>
      {art}
      <div className="min-w-0 flex-1">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">{title}</h1>
        {sub && <div className="mt-3 text-muted">{sub}</div>}
        {children && <div className="mt-6">{children}</div>}
      </div>
    </div>
  );
}
