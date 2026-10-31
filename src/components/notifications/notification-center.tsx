"use client"

import * as React from "react"
import { Link } from "react-router-dom"
import {
  ArrowRight,
  Bell,
  BellOff,
  CheckCheck,
  CircleAlert,
  CloudUpload,
  History,
  Info,
  ShieldAlert,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  AUDIT_SEVERITY_LABELS,
  AUDIT_SEVERITY_STYLES,
  type AuditEntry,
} from "@/lib/audit-api"
import { formatDateTime, formatRelative } from "@/lib/format"
import {
  useNotifications,
  type AppNotification,
  type NotificationLevel,
} from "@/lib/notifications"
import { cn } from "@/lib/utils"

const LEVEL_STYLES: Record<
  NotificationLevel,
  { icon: typeof Info; className: string }
> = {
  info: { icon: Info, className: "bg-info/10 text-info" },
  success: { icon: CheckCheck, className: "bg-success/10 text-success" },
  warning: { icon: TriangleAlert, className: "bg-warning/15 text-warning-foreground dark:text-warning" },
  critical: { icon: ShieldAlert, className: "bg-destructive/10 text-destructive" },
}

function NotificationRow({
  notification,
  unread,
  onRead,
}: {
  notification: AppNotification
  unread: boolean
  onRead: () => void
}) {
  const style = LEVEL_STYLES[notification.level]
  const Icon = style.icon
  const content = (
    <>
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
          style.className,
        )}
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <span className={cn("text-sm", unread ? "font-semibold" : "font-medium")}>
            {notification.title}
          </span>
          {unread && (
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
              aria-label="Non lue"
            />
          )}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {notification.description}
        </span>
        {notification.hint && (
          <span className="mt-1 block text-xs font-medium text-foreground/80">
            {notification.hint}
          </span>
        )}
        <time
          dateTime={notification.at}
          title={formatDateTime(notification.at)}
          className="mt-1 block text-[11px] text-muted-foreground"
        >
          {formatRelative(notification.at)}
        </time>
      </span>
    </>
  )

  const className = cn(
    "flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    unread && "bg-muted/30",
  )

  if (notification.href) {
    return (
      <Link to={notification.href} className={className} onClick={onRead}>
        {content}
        <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    )
  }

  return (
    <button type="button" className={className} onClick={onRead}>
      {content}
    </button>
  )
}

function ActivityRow({ entry }: { entry: AuditEntry }) {
  return (
    <li className="flex items-start gap-3 rounded-lg p-3 hover:bg-muted/50">
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
          AUDIT_SEVERITY_STYLES[entry.severity],
        )}
        aria-hidden="true"
      >
        <History className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{entry.action_label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {entry.entity_label} · {entry.actor_name}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          <span className="sr-only">Niveau : {AUDIT_SEVERITY_LABELS[entry.severity]}. </span>
          <time dateTime={entry.created_at} title={formatDateTime(entry.created_at)}>
            {formatRelative(entry.created_at)}
          </time>
        </p>
      </div>
    </li>
  )
}

/**
 * Indicateur de synchronisation, à côté de la cloche.
 *
 * Trois états lisibles d'un coup d'œil, et un seul message à retenir :
 * « à jour », « n en attente », « hors ligne ». Le détail vit dans le bandeau
 * hors ligne de la page ; ici on ne fait que rassurer ou alerter.
 */
export function SyncStatus() {
  const { numberOfPending, numberOfFailed } = useNotifications()
  const [online, setOnline] = React.useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  )

  React.useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener("online", goOnline)
    window.addEventListener("offline", goOffline)
    return () => {
      window.removeEventListener("online", goOnline)
      window.removeEventListener("offline", goOffline)
    }
  }, [])

  const state = numberOfFailed > 0
    ? { label: `${numberOfFailed} refusée${numberOfFailed > 1 ? "s" : ""}`, tone: "text-destructive", Icon: CircleAlert }
    : !online
      ? { label: "Hors ligne", tone: "text-warning", Icon: WifiOff }
      : numberOfPending > 0
        ? { label: `${numberOfPending} en attente`, tone: "text-warning", Icon: CloudUpload }
        : { label: "Synchronisé", tone: "text-success", Icon: Wifi }

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium text-muted-foreground"
      role="status"
      aria-live="polite"
      title={
        numberOfFailed > 0
          ? "Des opérations enregistrées hors ligne ont été refusées par le serveur. Ouvrez le bandeau hors ligne pour les traiter."
          : !online
            ? "Pas de réseau : les opérations sont conservées sur cet appareil et partiront automatiquement."
            : numberOfPending > 0
              ? "Des opérations attendent le retour du réseau. Elles ne sont pas perdues."
              : "Toutes les opérations sont enregistrées sur le serveur."
      }
    >
      <state.Icon className={cn("size-3.5", state.tone)} aria-hidden="true" />
      <span className="hidden lg:inline">{state.label}</span>
      <span className="sr-only lg:hidden">Synchronisation : {state.label}</span>
    </span>
  )
}

export function NotificationCenter() {
  const { notifications, unreadCount, markRead, markAllRead, isRead, activity, activityLoading, activityError, canReadActivity } =
    useNotifications()
  const [open, setOpen] = React.useState(false)

  const label =
    unreadCount > 0
      ? `Notifications : ${unreadCount} non lue${unreadCount > 1 ? "s" : ""}`
      : "Notifications : à jour"

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="relative size-9 md:size-8"
        onClick={() => setOpen(true)}
        aria-label={label}
        aria-haspopup="dialog"
      >
        <Bell aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b pr-12">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle className="flex items-center gap-2">
                <Bell className="size-4" aria-hidden="true" />
                Notifications
              </SheetTitle>
              {notifications.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={markAllRead}
                  disabled={unreadCount === 0}
                  className="h-8 gap-1.5"
                >
                  <CheckCheck className="size-3.5" aria-hidden="true" />
                  Tout lire
                </Button>
              )}
            </div>
            <SheetDescription>
              Alertes de la station et activité récente. Rien n'est inventé : chaque ligne
              renvoie à un fait enregistré.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            <section aria-labelledby="alerts-heading" className="p-3">
              <h3
                id="alerts-heading"
                className="px-1 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              >
                Alertes {unreadCount > 0 && `(${unreadCount})`}
              </h3>
              {notifications.length === 0 ? (
                <EmptyState
                  icon={BellOff}
                  title="Aucune alerte"
                  description="Tout est à jour : essai en cours, opérations synchronisées, aucune anomalie de caisse."
                />
              ) : (
                <ul className="space-y-1">
                  {notifications.map((notification) => (
                    <li key={notification.id}>
                      <NotificationRow
                        notification={notification}
                        unread={!isRead(notification.id)}
                        onRead={() => markRead(notification.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {canReadActivity && (
              <section aria-labelledby="activity-heading" className="border-t p-3">
                <div className="flex items-center justify-between px-1 pb-1">
                  <h3
                    id="activity-heading"
                    className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Activité récente
                  </h3>
                  <Button
                    variant="ghost"
                    size="xs"
                    render={<Link to="/history" />}
                    className="gap-1 text-xs"
                  >
                    Tout voir
                    <ArrowRight className="size-3" aria-hidden="true" />
                  </Button>
                </div>
                {activityLoading ? (
                  <div role="status" aria-busy="true" aria-label="Chargement de l'activité" className="space-y-2 p-1">
                    {[0, 1, 2, 3].map((row) => (
                      <div
                        key={row}
                        className="flex items-center gap-3 rounded-lg p-3"
                      >
                        <span className="size-7 animate-pulse rounded-full bg-muted" />
                        <span className="flex-1 space-y-2">
                          <span className="block h-3 w-2/3 animate-pulse rounded bg-muted" />
                          <span className="block h-2.5 w-1/2 animate-pulse rounded bg-muted" />
                        </span>
                      </div>
                    ))}
                  </div>
                ) : activityError ? (
                  <p className="px-1 py-3 text-sm text-muted-foreground">
                    L'activité n'a pas pu être chargée ({activityError}). Réessayez dans un
                    instant ou ouvrez la page Historique.
                  </p>
                ) : activity.length === 0 ? (
                  <p className="px-1 py-3 text-sm text-muted-foreground">
                    Aucune activité enregistrée pour le moment. Les lavages, paiements et
                    changements de rôle apparaîtront ici.
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {activity.slice(0, 6).map((entry) => (
                      <ActivityRow key={entry.id} entry={entry} />
                    ))}
                  </ul>
                )}
              </section>
            )}

            {!canReadActivity && (
              <p className="border-t p-4 text-xs text-muted-foreground">
                Le journal d'activité est réservé aux rôles qui peuvent consulter
                l'historique. Vos alertes personnelles restent visibles ici.
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
