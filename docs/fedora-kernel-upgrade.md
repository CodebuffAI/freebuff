# Fedora 32 → Kernel 6.12 LTS — Safe Upgrade Runbook

> **Scope:** This runbook targets a Fedora 32 host running kernel `5.6.19-300.fc32.x86_64`.
> Fedora 32 is EOL and its kernel receives no security fixes. The goal is a **safe,
> reversible** move to a 6.12 LTS kernel with full backup and rollback capability.
>
> **Safety rules baked in:** never remove the running kernel until the new one boots
> successfully; always keep ≥2 bootable kernels; verify in a rescue/VM first if possible.

---

## 0. Pre-flight (do NOT skip)

```bash
# Confirm distro & kernel
cat /etc/fedora-release
uname -r                 # expect 5.6.19-300.fc32.x86_64

# Disk space (need >= 2 GiB free on /boot and /)
df -h /boot / /var

# Are we on LVM/LUKS/btrfs?
lsblk -f
findmnt -n -o FSTYPE /   # btrfs vs ext4 affects snapshot tooling

# Secure Boot / UEFI?
mokutil --sb-state 2>/dev/null || echo "mokutil not installed (likely BIOS/legacy)"
bootctl status 2>/dev/null | head -20
```

**Stop conditions** — abort if any is true:
- `/boot` < 1 GiB free.
- Root filesystem is encrypted (LUKS) and you have **no** recovery key written down.
- You are on a remote host with no out-of-band console (iLO/iDRAC/IPMI/serial) — a
  bad kernel means a truck roll. Use a test VM first.
- Proprietary NVIDIA/AMD drivers are loaded (`lsmod | grep -E 'nvidia|amdgpu'`) —
  plan extra rebuild steps (Section 6).

---

## 1. Full backup

```bash
# 1a. Snapshot (btrfs) — preferred if root is btrfs
sudo btrfs subvolume snapshot / /rootfs-pre-kernel-upgrade-$(date +%F)

# 1b. Timeshift (ext4/btrfs) — install if missing
sudo dnf install -y timeshift   # from archived repos (see §2)
sudo timeshift --create --comments "pre-kernel-upgrade-$(date +%F)"

# 1c. Manual tarball of /boot + /etc (always, regardless of FS)
sudo tar -czpf /root/boot-etc-backup-$(date +%F).tar.gz /boot /etc /root
ls -lh /root/boot-etc-backup-*.tar.gz

# 1d. Package list for rebuild
rpm -qa | sort > /root/rpm-list-$(date +%F).txt
dnf history list > /root/dnf-history-$(date +%F).txt

# 1e. LUKS header backup (if encrypted)
sudo cryptsetup luksHeaderBackup /dev/sdXN --header-backup-file /root/luks-header-$(date +%F).img
```

Store at least one copy (backup tarball + LUKS header + package list) **off-machine**
(USB, another host). Do not keep only on the machine being upgraded.

---

## 2. Restore Fedora 32 package access (EOL repos)

Fedora 32 repos are archived. Point dnf at the archive before doing anything else.

```bash
sudo sed -i 's|^metalink=|#metalink=|; s|^#baseurl=http://download.fedoraproject.org/pub/fedora/linux/|baseurl=https://archives.fedoraproject.org/pub/archive/fedora/linux/|' \
  /etc/yum.repos.d/fedora*.repo
sudo dnf clean all
sudo dnf makecache
```

Verify with `sudo dnf repolist`.

---

## 3. Strategy decision

You have three realistic paths. Pick ONE.

### Path A — Full OS upgrade first (RECOMMENDED & SAFEST)
Upgrade Fedora 32 → 33 → … → 40 (or latest) with `dnf system-upgrade`. This
brings a modern, supported userspace AND a modern kernel (~6.8+). Then optionally
install a 6.12 LTS kernel (Path C) on top of the supported release.

Pros: supported userspace, modern firmware, modern dracut, Secure Boot signing
works, NVIDIA akmods rebuild automatically.
Cons: long, many reboots, config drift risk.

### Path B — Install a newer kernel on Fedora 32 (NOT RECOMMENDED)
Pull a 6.12 kernel RPM from a copr/rawhide or build from source and install it
onto the ancient Fedora 32 userspace. Frequently fails to boot because of
glibc/systemd/dracut/firmware mismatch. Only attempt in a VM.

### Path C — Build 6.12 LTS from kernel.org source (advanced)
Compile `linux-6.12.x` with the running config, install modules + bzImage, update
GRUB. Useful for embedded/custom needs. Requires ~10 GiB and 1–3 h.

**Recommendation:** Path A, then Path C only if you specifically need 6.12 LTS
features not in the distro kernel. Most users should stop after Path A.

---

## 4. Path A — Incremental Fedora upgrade

```bash
# Install the upgrade plugin (from archived repos)
sudo dnf install -y dnf-plugin-system-upgrade

# One hop at a time. Repeat for each release: 32->33, 33->34, ..., up to target.
TARGET=33
sudo dnf system-upgrade download --releasever=$TARGET --allowerasing
# Review the transaction carefully before confirming. Then:
sudo dnf system-upgrade reboot
# System reboots into upgrade; may take 30-90 min. Do not interrupt.

# After reboot, verify:
cat /etc/fedora-release
uname -r
```

Repeat the hop loop until you reach a supported release (e.g. 40). Between hops,
run `sudo dnf upgrade --refresh` and reboot once to settle.

**Rollback for a failed hop:** at GRUB, select the previous kernel entry, boot,
then `sudo dnf system-upgrade clean` and retry. If the upgrade transaction is
broken, restore from the Timeshift/btrfs snapshot (Section 7).

---

## 5. Path C — Build & install kernel 6.12 LTS (after Path A, or on F32 in a VM)

### 5.1 Dependencies

```bash
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y ncurses-devel bison flex elfutils-libelf-devel \
  openssl-devel bc dwarves pahole rsync grub2-tools
```

### 5.2 Download & verify

```bash
cd /usr/src
KVER=6.12.5        # adjust to latest 6.12.x from kernel.org
wget https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KVER}.tar.xz
wget https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KVER}.tar.sign

# Verify PGP signature (import keys first if needed)
gpg --verify linux-${KVER}.tar.sign linux-${KVER}.tar.xz
tar -xf linux-${KVER}.tar.xz
cd linux-${KVER}
```

### 5.3 Configure

```bash
# Start from the running kernel's config
cp /boot/config-$(uname -r) .config
# Update config for new options (accept defaults for new symbols)
make olddefconfig
# Optional: tune
# make menuconfig
```

### 5.4 Build

```bash
# Parallel build (use nproc cores)
make -j$(nproc) 2>&1 | tee /root/kernel-build-$(date +%F).log
# Build modules
make modules -j$(nproc)
```

### 5.5 Install (modules + kernel + initramfs)

```bash
sudo make modules_install
sudo make install          # installs vmlinuz, System.map, config to /boot
# Rebuild initramfs with dracut (Fedora standard)
sudo dracut --force --regenerate-all
```

`make install` invokes the distro's kernel install scripts which update GRUB on
Fedora. Verify a new entry exists:

```bash
sudo grubby --info=ALL | grep -E 'title|kernel'
```

### 5.6 Keep old kernels (rollback safety)

Fedora keeps the last 3 kernels by default (`installonly_limit=3` in
`/etc/dnf/dnf.conf`). Do NOT lower this. Confirm:

```bash
grep installonly_limit /etc/dnf/dnf.conf || echo "installonly_limit=3 (default)"
```

---

## 6. Proprietary drivers (NVIDIA/AMD) — if applicable

```bash
# Check
lsmod | grep -E 'nvidia|amdgpu|radeon'

# NVIDIA via akmods (RPM Fusion) — rebuild for new kernel
sudo dnf install -y akmod-nvidia
sudo akmods --force   # builds kmod for current (new) kernel
# Or wait for the akmods systemd service on next boot.
```

For AMDGPU/ROCm, ensure `linux-firmware` is current:
`sudo dnf install -y linux-firmware`.

---

## 7. Boot verification & rollback

### 7.1 First boot into the new kernel
Reboot, pick the new kernel in GRUB (or let default take it). Then:

```bash
uname -r                 # should show 6.12.x
dmesg | grep -iE 'error|fail|panic' | head
lsmod | head
systemctl --failed
```

### 7.2 If it fails to boot
At GRUB menu → select the **previous** (5.6.x or distro) kernel → boot. Then:
```bash
# Remove the broken kernel (only after confirming old kernel boots)
sudo dnf remove kernel-6.12.x   # if installed via RPM
# or, for a source build, remove files manually:
# /boot/vmlinuz-6.12.x, /boot/initramfs-6.12.x.img, /lib/modules/6.12.x
sudo grub2-mkconfig -o /boot/grub2/grub.cfg
```

### 7.3 Restore from snapshot (last resort)
- **btrfs:** boot from rescue USB, mount root, `btrfs subvolume delete` current +
  rename snapshot back.
- **Timeshift:** `sudo timeshift --restore` (interactive).
- **Manual tarball:** boot rescue USB, mount root, extract
  `/root/boot-etc-backup-*.tar.gz`.

---

## 8. Post-upgrade hardening

```bash
# SELinux relabel (if contexts look wrong)
sudo restorecon -Rv /boot /lib/modules 2>&1 | tail

# Secure Boot: if enabled, custom-built kernels are NOT signed -> boot fails.
# Either disable Secure Boot in firmware, or sign with MOK:
# sudo mokutil --import /path/to/MOK.der  (then enroll on next boot)

# Verify no EOL kernel remains as default
grubby --default-kernel
```

---

## 9. Verification checklist

- [ ] `uname -r` reports 6.12.x (or distro kernel ≥6.6 on Path A).
- [ ] `systemctl --failed` shows no failed units.
- [ ] `dmesg` has no panic/oops.
- [ ] Network, storage, GPU work.
- [ ] Old kernel still present in GRUB (rollback available).
- [ ] Backup tarball + LUKS header stored off-machine.
- [ ] Secure Boot state accounted for.

---

## Quick rollback one-liner (emergency)

```bash
# Reboot -> GRUB -> pick previous kernel. Then on next boot:
sudo grubby --set-default /boot/vmlinuz-$(ls /boot | grep '^vmlinuz-5\.' | sort | tail -1)
sudo grub2-mkconfig -o /boot/grub2/grub.cfg
```

---

*Generated for Fedora 32 EOL host. Test in a VM before touching production.*
