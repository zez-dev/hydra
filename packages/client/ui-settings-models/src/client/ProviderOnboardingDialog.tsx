/**
 * First-run API-key step. Readiness comes from the same
 * provider/settings/credential join as the Models page: any provider the user
 * can already talk to ends the step, and only a user with none is offered the
 * configured onboarding provider. The step reuses that page's credential
 * editor in the onboarding plugin's shared modal, so the key is entered once.
 */
import type { TrackProductEvent } from '@deepseek-ai/dsh-client-product-analytics/client'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import { onboardingReadiness, onboardingRow } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor } from './ProviderEditor.tsx'
import type {} from './slot-contract.ts'
import type { en } from './locales.ts'
import { OnboardingModal } from './OnboardingModal.tsx'
import styles from './ProviderOnboardingDialog.module.css'

/** Registration-side dependencies of {@link ProviderOnboardingDialog}. */
export interface ProviderOnboardingInjected {
  /** Desktop-only event collection. */
  track?: TrackProductEvent
  /** Whether first-run setup should show automatically. Explicit requests remain available. */
  automatic: boolean
  /** Provider route whose credential the step asks for. */
  provider: string
  hooks: {
    /** Shared Models-page join state, bound by the slot renderer. */
    models: SnapshotStore<ModelsSettingsState>
  }
  /** Shared Models-page join controller. */
  controller: ModelsSettingsStore
  /** The Host operations the reused Models credential editor writes through. */
  operations: ModelsOperations
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type ProviderOnboardingDialogProps =
  PropsRuntime<'settings.onboarding'> & PropsRenderSlots<'settings.models.sign-in'> & InjectFace<ProviderOnboardingInjected>

/* v8 ignore next 3 -- closed-union defaults only defend future source widening */
function assertNever(_value: never): never {
  throw new Error('unexpected provider onboarding state')
}

/**
 * Prompt a first-run user for the onboarding provider's credential while no
 * provider can serve requests and that credential is writable.
 * @param props - settings-shell owner state and Models feature dependencies.
 * @returns the onboarding modal or null when onboarding needs no intervention.
 */
export function ProviderOnboardingDialog(props: ProviderOnboardingDialogProps): ReactNode {
  const { complete, controller, useModels, operations, schema, t, renderSlot, automatic, provider, explicit = false } = props
  const [apiKey, setApiKey] = useState(explicit)
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state, provider)

  useEffect(() => {
    if ((automatic || explicit) && state.status === 'idle') void controller.load()
  }, [controller, state.status, automatic, explicit])

  useEffect(() => {
    if (
      (!automatic && !explicit)
      || readiness.kind === 'adapter-absent'
      || (!explicit && readiness.kind === 'provider-ready')
      || readiness.kind === 'unavailable'
    ) complete()
  }, [complete, readiness.kind, explicit, automatic])

  if (!automatic && !explicit) return null

  switch (readiness.kind) {
    case 'loading':
    case 'adapter-absent':
    case 'unavailable':
      return null
    case 'provider-ready':
      if (!explicit) return null
      break
    case 'credential-missing':
      break
    /* v8 ignore next -- every current readiness variant is handled above */
    default:
      return assertNever(readiness)
  }

  const row = onboardingRow(state, provider)
  const namespace = row === undefined ? undefined : state.namespaces.get(row.entry.settingsNs)
  /* v8 ignore next 2 -- credential-missing and explicit provider-ready resolve this row and its namespace. */
  if (row === undefined || namespace === undefined) return null

  const finishCredential = (changed: boolean): void => {
    if (!changed) {
      complete()
      return
    }
    void (async () => {
      // The stored key makes this provider usable, so a saved default the
      // catalog no longer lists moves to its first model. A refusal keeps the
      // saved default; the composer reports it as unavailable.
      const refused = await operations.initializeDefaultModel(row.entry.provider)
      if (refused !== undefined) console.warn('[ui-settings-models] default model unchanged', { reason: 'refused' })
      await controller.load()
    })()
  }

  const editor = (
    <OnboardingModal title={t('onboardingTitle')}>
      <p className={styles.description}>{t('onboardingDescription').replace('{provider}', () => row.entry.displayName)}</p>
      <div className={styles.editor}>
        <ProviderEditor
          provider={row.entry.provider}
          displayName={row.entry.displayName}
          namespace={namespace}
          schema={schema}
          settingsPath={row.entry.settingsPath}
          operations={operations}
          t={t}
          readOnly={false}
          hideTitle
          credentialOnly
          onSubmitCredential={() => { props.track?.('api_key_save_click', {}) }}
          credentialRequired
          autoFocusCredential
          cancelLabelKey="onboardingLater"
          submitLabelKey="onboardingSave"
          submitBusyLabelKey="onboardingSaving"
          onClose={finishCredential}
        />
      </div>
    </OnboardingModal>
  )
  return apiKey ? editor : renderSlot('settings.models.sign-in', { complete, useApiKey: () => { setApiKey(true) } }, { fallback: editor })
}
