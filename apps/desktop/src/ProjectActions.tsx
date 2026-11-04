import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, FolderKanban, Info, LoaderCircle, MoreHorizontal, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import type { WorkspaceProject } from "../../../packages/domain/src/workspace.js";
import type { TextKey } from "./i18n";
import { ApiError, request } from "./api";
import "./project-actions.css";

export type ProjectAction = "rename" | "info" | "trash" | "restore";
type Text = (key: TextKey) => string;
type MenuProps = { project: WorkspaceProject; t: Text; disabled?: boolean; children?: ReactNode; header?: boolean;
  onOpen: (project: WorkspaceProject) => void;
  onAction: (action: ProjectAction, project: WorkspaceProject, trigger: HTMLElement | null) => void };

/** One menu composition for cards and the selected project's header. */
export function ProjectMenu({ project, t, disabled, children, header, onOpen, onAction }: MenuProps) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const commands = [
    { key: "open", label: t("open"), icon: ArrowUpRight },
    { key: "rename", label: t("renameProject"), icon: Pencil },
    { key: "info", label: t("editProjectInfo"), icon: Info },
    { key: "trash", label: t("trashProject"), icon: Trash2 }
  ] as const;
  function show(x?: number, y?: number) {
    if (disabled) return;
    const rect = trigger.current?.getBoundingClientRect();
    setPosition({ x: x ?? rect?.right ?? 0, y: y ?? rect?.bottom ?? 0 });
  }
  function close(focus = true) { setPosition(null); if (focus) trigger.current?.focus(); }
  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8))}px`;
    menu.current.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8))}px`;
    menu.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const dismiss = () => { setPosition(null); trigger.current?.focus(); };
    const anchor = trigger.current?.getBoundingClientRect();
    const scrolled = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect && anchor && (rect.top !== anchor.top || rect.left !== anchor.left)) dismiss();
    };
    document.addEventListener("pointerdown", outside); window.addEventListener("resize", dismiss);
    // Menus are viewport anchored; close before their scroll anchor moves.
    document.addEventListener("scroll", scrolled, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", dismiss); document.removeEventListener("scroll", scrolled, true); };
  }, [position]);
  useEffect(() => { if (disabled) setPosition(null); }, [disabled]);
  return <div className={`project-action-host ${children && !header ? "project-action-card" : "project-action-header"}`}
    onContextMenu={event => { if (!disabled) { event.preventDefault(); show(event.clientX, event.clientY); } }}
    onKeyDown={event => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); show(); } }}>
    {children}
    <button ref={trigger} type="button" className="icon-button project-menu-trigger" disabled={disabled}
      aria-label={`${t("projectActions")}: ${project.name}`} title={t("projectActions")} aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? id : undefined}
      onClick={() => { if (position) close(); else show(); }}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); } }}><MoreHorizontal size={19} /></button>
    {position && createPortal(<div ref={menu} id={id} role="menu" aria-label={`${t("projectActions")}: ${project.name}`} className="project-menu" style={{ left: position.x, top: position.y }}
      onKeyDown={event => {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus({ preventScroll: true });
        } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === "Tab") { event.preventDefault(); close(); }
      }}>
      {commands.map(command => <button type="button" key={command.key} role="menuitem" tabIndex={-1} className={command.key === "trash" ? "project-menu-danger" : ""}
        onClick={() => { close(); if (command.key === "open") onOpen(project); else onAction(command.key, project, trigger.current); }}><command.icon size={15} />{command.label}</button>)}
    </div>, document.body)}
  </div>;
}

export function ProjectCard(props: MenuProps & { selected?: boolean }) {
  return <article className={`project-card managed-project-card ${props.selected ? "selected-project" : ""}`}>
    <ProjectMenu {...props}><button type="button" className="project-card-open" disabled={props.disabled} onClick={() => props.onOpen(props.project)}>
      <span className="project-symbol"><FolderKanban size={20} /></span><span className="project-card-copy"><strong>{props.project.name}</strong><span>{props.project.description || "—"}</span></span>
      <span className="project-card-bottom">{props.t(props.selected ? "selected" : "open")}<ArrowUpRight size={14} /></span>
    </button></ProjectMenu>
  </article>;
}

export type ProjectDialogValue = { action: ProjectAction; project: WorkspaceProject; trigger: HTMLElement | null };
export function ProjectDialog({ value, t, date, errorText, onClose, onSave }: {
  value: ProjectDialogValue | null; t: Text; date: (value: string) => string; errorText: (error: unknown) => string;
  onClose: () => void; onSave: (project: WorkspaceProject, action: ProjectAction, fields?: { name: string; description: string }) => Promise<void>;
}) {
  const [current, setCurrent] = useState(value?.project), [pending, setPending] = useState(false), [error, setError] = useState<unknown>(null);
  const lock = useRef(false), generation = useRef(0), returnTo = useRef<HTMLElement | null>(null);
  const name = useRef<HTMLInputElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { ++generation.current; setCurrent(value?.project); setError(null); setPending(false); lock.current = false; if (value) returnTo.current = value.trigger; }, [value]);
  const conflict = error instanceof ApiError && error.code === "revision_conflict";
  const action = value?.action, editing = action === "rename" || action === "info";
  async function perform(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!value || !current || lock.current) return;
    const data = new FormData(event.currentTarget), token = generation.current;
    lock.current = true; setPending(true); setError(null);
    try { await onSave(current, value.action, editing ? { name: String(data.get("name") ?? ""), description: action === "rename" ? current.description : String(data.get("description") ?? "") } : undefined); }
    catch (failure) { if (token === generation.current) setError(failure); }
    finally { if (token === generation.current) { lock.current = false; setPending(false); } }
  }
  async function reload() {
    if (!current || lock.current) return;
    const token = generation.current; lock.current = true; setPending(true);
    try {
      const projects = await request<WorkspaceProject[]>(`/api/projects?${new URLSearchParams({ accountId: current.accountId, state: action === "restore" ? "trashed" : "active" })}`);
      if (token !== generation.current) return;
      const latest = projects.find(p => p.id === current.id); if (!latest) throw new ApiError("project_not_found");
      setCurrent(latest); setError(null); requestAnimationFrame(() => name.current?.focus());
    } catch (failure) { if (token === generation.current) setError(failure); }
    finally { if (token === generation.current) { lock.current = false; setPending(false); } }
  }
  const title = t(action === "rename" ? "renameProject" : action === "info" ? "editProjectInfo" : action === "restore" ? "projectRestoreTitle" : "projectTrashTitle");
  return <Dialog.Root open={!!value} onOpenChange={open => { if (!open && !lock.current) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content project-dialog" aria-describedby={`${id}-description`}
      onOpenAutoFocus={event => { event.preventDefault(); (editing ? name.current : cancel.current)?.focus(); if (editing) name.current?.select(); }}
      onCloseAutoFocus={event => { event.preventDefault(); const target = returnTo.current?.isConnected ? returnTo.current : document.querySelector<HTMLElement>('.nav-item[aria-current="page"]'); target?.focus(); }}
      onEscapeKeyDown={event => { if (lock.current) event.preventDefault(); }} onPointerDownOutside={event => { if (lock.current) event.preventDefault(); }}>
      <Dialog.Title>{title}</Dialog.Title><Dialog.Description id={`${id}-description`}>{t(editing ? "projectInfoHelp" : action === "restore" ? "projectRestoreHelp" : "projectTrashHelp")}</Dialog.Description>
      <Dialog.Close className="icon-button dialog-close" disabled={pending} aria-label={t("close")}><X size={18} /></Dialog.Close>
      {current && <form key={`${current.id}:${current.revision}`} onSubmit={event => { void perform(event); }} aria-busy={pending}>
        {editing ? <><label className="form-field">{t("name")}<input ref={name} name="name" required maxLength={100} defaultValue={current.name} autoComplete="off" disabled={pending} /></label>
          {action === "info" && <label className="form-field">{t("description")}<textarea name="description" maxLength={500} rows={4} defaultValue={current.description} disabled={pending} /></label>}
        </> : <blockquote className="delete-preview">{current.name}</blockquote>}
        {action === "info" && <dl className="project-details"><div><dt>{t("createdAt")}</dt><dd>{date(current.createdAt)}</dd></div><div><dt>{t("updatedAt")}</dt><dd>{date(current.updatedAt)}</dd></div><div><dt>{t("revision")}</dt><dd>{current.revision}</dd></div></dl>}
        {!!error && <div className="form-error" role="alert"><p>{conflict ? t("projectConflict") : errorText(error)}</p>{conflict && <button type="button" className="text-button" disabled={pending} onClick={() => { void reload(); }}>{t("reloadProject")}</button>}</div>}
        <div className="dialog-actions"><button ref={cancel} type="button" className="button secondary" disabled={pending} onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className={`button ${action === "trash" ? "danger" : "primary"}`} disabled={pending || conflict}>{pending && <LoaderCircle size={15} className="spinning" />}{t(pending ? "saving" : editing ? "save" : action === "restore" ? "restoreProject" : "trashProject")}</button></div>
      </form>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function ProjectTrash({ accountId, t, date, errorText, onRestore, version }: {
  accountId: string; t: Text; date: (value: string) => string; errorText: (error: unknown) => string; version: number;
  onRestore: (project: WorkspaceProject, trigger: HTMLElement) => void;
}) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]), [error, setError] = useState<unknown>(null), [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(null); setProjects([]);
    void request<WorkspaceProject[]>(`/api/projects?${new URLSearchParams({ accountId, state: "trashed" })}`, "GET", undefined, abort.signal)
      .then(result => { if (!abort.signal.aborted) setProjects(result); })
      .catch(failure => { if (!abort.signal.aborted) setError(failure); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [accountId, version, retry]);
  return <section className="section project-trash" aria-label={t("projectTrash")} aria-busy={loading}>
    <p className="section-note">{t("projectTrashDescription")}</p>
    {loading ? <p role="status" className="loading-state"><LoaderCircle size={18} className="spinning" />{t("loading")}</p> : error ? <div className="error-banner" role="alert"><span>{errorText(error)}</span><button className="text-button" onClick={() => setRetry(n => n + 1)}>{t("retry")}</button></div> : projects.length ? <ul className="project-trash-list">{projects.map(project => <li key={project.id}><Trash2 size={18} /><div><strong>{project.name}</strong><p>{project.description}</p><span>{t("deletedAt")} · {date(project.deletedAt!)}</span></div><button className="button secondary" onClick={event => onRestore(project, event.currentTarget)}><RotateCcw size={15} />{t("restoreProject")}</button></li>)}</ul> : <div className="inline-empty"><Trash2 size={20} />{t("projectTrashEmpty")}</div>}
  </section>;
}
