# Migrating the Origin of an Installed Web App

Transferring an installed web app (PWA) to a new origin typically requires users to manually uninstall the old app and reinstall the new one. This process usually causes the loss of OS-level integration, such as taskbar shortcuts and notification permissions. Web App Origin Migration automates this transition by establishing a secure handover between the old and new origins.

The migration is a two-step verification process: the new site claims the old site as its predecessor, and the old site authorizes the new site as its successor.

### Important Constraints

> [!WARNING]
> **Data and Permissions are NOT migrated.**
> This feature only migrates the **installation** (shortcuts, home screen icons). User data (LocalStorage, IndexedDB, Cookies) and browser permissions (Notifications, Geolocation) are tied to the origin and are NOT transferred. You must migrate data separately using cross-origin messaging or server-side synchronization.

## Implementation steps

### 1. Verification of "Same-Site" status

MANDATORY: Both the new and old origins MUST be **"Same-Site"**. They must share the same **Registrable Domain (eTLD+1)**.

*   **Allowed**: Migrating from `app.example.com` to `new.example.com` (both share `example.com`).
*   **Allowed**: Migrating from `example.com/app1` to `example.com/app2`.
*   **Prohibited**: Migrating from `example.com` to `example.org` (different registrable domains).

### 2. Configure the new application

The new application must declare its predecessor. The new app must have an `id`.

In the **new** site's `manifest.json`, add the `migrate_from` field:

```json
{
  "name": "My New App",
  "id": "/demo.html",
  "start_url": "/demo.html",
  "migrate_from": [
    {
      "id": "https://old-app.example.com/"
    }
  ]
}
```

### 3. Authorize the migration on the old origin

The old origin must explicitly authorize the migration to prevent origin hijacking. Create a configuration file served from the `.well-known` directory.

File location: `https://old-app.example.com/.well-known/web-app-origin-association`

```json
{
  "https://new-app.example.com/demo.html": {
    "allow_migration": true
  }
}
```

### 4. Proactively signal the migration (Optional)

To let the browser discover the migration from the old installation, without waiting for users to visit the new site, add a `migrate_to` member to the **old** site's `manifest.json`. Set its `id` to the new app's manifest ID:

```json
{
  "migrate_to": {
    "id": "https://new-app.example.com/demo.html",
    "install_url": "https://new-app.example.com/demo.html"
  }
}
```

### 5. Require users to migrate (Optional)

By default, a migration is suggested to users. To make the transition mandatory, set the `behavior` to `force` in the **new** app's manifest.

```json
{
  "migrate_from": [
    {
      "id": "https://old-app.example.com/",
      "behavior": "force"
    }
  ]
}
```

**Note**: `behavior: "force"` does not silently delete the old app. The browser will present the user with a dialog requiring them to either **Update** to the new version or **Remove** the app entirely.

## Fallbacks & browser support

Browser support for Web app origin migration: Limited availability.
Supported by: Chrome 149 (Jun 2026) and Edge 149 (Jun 2026).
Unsupported in: Firefox and Safari.

### Manual reinstallation prompt

For browsers that do not support automatic migration, the user will remain on the old installation. You should implement a UI element (e.g., a notification banner) on the old origin that directs the user to the new site.

The user's settings will not be migrated, and the old app will not be automatically uninstalled.
