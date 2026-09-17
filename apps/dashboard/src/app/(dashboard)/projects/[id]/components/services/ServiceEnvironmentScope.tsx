import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { projectsApi } from "@/lib/api/projects";

/** Names only: explaining precedence never needs to reveal a secret value. */
export function ServiceEnvironmentScope({
  projectId,
  keys,
}: {
  projectId: string;
  keys: readonly string[];
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.serviceEnvironment;
  const [shared, setShared] = useState<{
    projectId: string;
    keys: string[];
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    projectsApi
      .getEnv(projectId)
      .then((result) => {
        if (!cancelled)
          setShared({
            projectId,
            keys: result.data
              .filter((row) => row.environment === "production")
              .map((row) => row.key),
          });
      })
      .catch(() => {
        if (!cancelled) setShared({ projectId, keys: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const current = shared?.projectId === projectId ? shared : null;
  const sharedKeys = new Set(current?.keys);
  const overrides = [...new Set(keys.map((key) => key.trim()))]
    .filter((key) => sharedKeys.has(key))
    .sort();

  return (
    <div className="space-y-2 border-b border-border/40 px-5 py-4">
      <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
      <p className="text-xs text-muted-foreground">{copy.description}</p>
      {overrides.length > 0 && (
        <p className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
          {interpolate(copy.overrides, { keys: overrides.join(", ") })}
        </p>
      )}
      {current?.failed && <p className="text-xs text-muted-foreground">{copy.loadFailed}</p>}
      <p className="text-xs text-muted-foreground">{copy.buildArguments}</p>
      <Link
        href={`/projects/${projectId}/runtime`}
        className="inline-block text-xs font-medium text-primary hover:underline"
      >
        {copy.projectLink}
      </Link>
    </div>
  );
}
