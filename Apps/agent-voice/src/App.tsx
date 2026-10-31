import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Settings from './components/Settings'
import Overlay from './components/Overlay'
import UpgradeDialog from './components/UpgradeDialog'
import { listenForActivation } from './lib/entitlement'
import { useStore } from './state/store'

/** One bundle, two windows: the settings shell and the dictation overlay are
 *  the same webview app, picked by window label. */
export default function App() {
  const label = getCurrentWindow().label
  const activate = useStore((s) => s.activate)
  const refresh = useStore((s) => s.refresh)
  const note = useStore((s) => s.note)
  const setUpgrading = useStore((s) => s.setUpgrading)

  useEffect(() => {
    if (label !== 'main') return
    // Checkout can come back as agentvoice://activate?key=… — activate then
    // close the upgrade dialog if we are already Pro.
    void listenForActivation(
      (state) => {
        if (state.entitlement.tier === 'pro') setUpgrading(false)
      },
      (message) => note(message),
    ).then((unlisten) => {
      void refresh()
      window.addEventListener('beforeunload', unlisten, { once: true })
    })
    return () => note(null)
  }, [label, activate, refresh, note, setUpgrading])

  return (
    <>
      {label === 'overlay' ? <Overlay /> : <Settings />}
      {label === 'main' && <UpgradeDialog />}
    </>
  )
}
