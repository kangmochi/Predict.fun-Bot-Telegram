#!/usr/bin/env bash
# Keep the home mini PC (HP EliteDesk / Ubuntu Server) awake 24/7.
# Does NOT change trading gates, .env, or --live. Safe to re-run.
#
#   sudo bash deploy/harden-24-7.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Jalankan: sudo bash deploy/harden-24-7.sh"
  exit 1
fi

echo "==> 1. Matikan sleep / suspend / hibernate / idle"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
mkdir -p /etc/systemd/logind.conf.d
cat >/etc/systemd/logind.conf.d/no-idle.conf <<'EOF'
[Login]
IdleAction=ignore
IdleActionSec=0
HandleSuspendKey=ignore
HandleHibernateKey=ignore
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
HandleRebootKey=reboot
HandlePowerKey=poweroff
EOF
# Jangan restart logind di sini — bisa memutus SSH. Berlaku setelah reboot.

echo "==> 2. Jangan blank konsol + jangan autosuspend USB/PCI"
mkdir -p /etc/modprobe.d
cat >/etc/modprobe.d/usb-no-autosuspend.conf <<'EOF'
options usbcore autosuspend=-1
EOF
cat >/etc/udev/rules.d/99-no-power-save.rules <<'EOF'
# USB and PCI stay on — autosuspend on Intel SFF often looks like a freeze.
ACTION=="add", SUBSYSTEM=="usb", TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEM=="pci", TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEM=="scsi_host", TEST=="link_power_management_policy", ATTR{link_power_management_policy}="max_performance"
EOF
udevadm control --reload
udevadm trigger --action=add --subsystem-match=usb --subsystem-match=pci --subsystem-match=scsi_host || true
for f in /sys/bus/usb/devices/*/power/control /sys/bus/pci/devices/*/power/control; do
  [ -f "$f" ] && echo on >"$f" 2>/dev/null || true
done
echo 0 >/sys/module/kernel/parameters/consoleblank 2>/dev/null || true
setterm -blank 0 -powerdown 0 -powersave off </dev/tty1 2>/dev/null || true

echo "==> 3. Driver layar Intel: jangan hemat daya panel (penyebab hang + No Signal)"
cat >/etc/modprobe.d/i915-24-7.conf <<'EOF'
options i915 enable_psr=0 enable_dc=0 enable_fbc=0 enable_guc=0
EOF

echo "==> 4. GRUB: IOMMU GPU off, ASPM off, C-state dalam (anti freeze Coffee Lake)"
if [ ! -f /etc/default/grub.bak-24-7 ]; then
  cp -a /etc/default/grub /etc/default/grub.bak-24-7
fi
GRUB_LINE='consoleblank=0 intel_iommu=igfx_off i915.enable_psr=0 i915.enable_dc=0 i915.enable_fbc=0 i915.enable_guc=0 pcie_aspm=off intel_idle.max_cstate=2 usbcore.autosuspend=-1'
if grep -q '^GRUB_CMDLINE_LINUX=' /etc/default/grub; then
  sed -i "s|^GRUB_CMDLINE_LINUX=.*|GRUB_CMDLINE_LINUX=\"${GRUB_LINE}\"|" /etc/default/grub
else
  echo "GRUB_CMDLINE_LINUX=\"${GRUB_LINE}\"" >>/etc/default/grub
fi
update-grub

echo "==> 5. Jangan reboot sendiri karena apt update"
mkdir -p /etc/apt/apt.conf.d
cat >/etc/apt/apt.conf.d/99no-auto-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
EOF

echo "==> 6. Bot selalu hidup lagi kalau Node mati (tanpa mengubah --live)"
mkdir -p /etc/systemd/system/predict-fun-bot.service.d
cat >/etc/systemd/system/predict-fun-bot.service.d/keepalive.conf <<'EOF'
[Service]
Restart=always
RestartSec=10
StartLimitIntervalSec=0
EOF
systemctl daemon-reload

echo "==> 7. Matikan Bluetooth / Wi-Fi hemat daya jika ada"
systemctl disable --now bluetooth.service 2>/dev/null || true
rfkill block bluetooth 2>/dev/null || true
if command -v iw >/dev/null 2>&1; then
  for dev in $(iw dev 2>/dev/null | awk '/Interface/{print $2}'); do
    iw dev "$dev" set power_save off 2>/dev/null || true
  done
fi

echo "==> 8. Journal tahan reboot, jangan memenuhi SSD"
mkdir -p /etc/systemd/journald.conf.d /var/log/journal
cat >/etc/systemd/journald.conf.d/size.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=200M
MaxRetentionSec=14day
EOF
systemctl restart systemd-journald.service

echo
echo "=== status singkat ==="
echo -n "sleep.target: "; systemctl is-enabled sleep.target 2>/dev/null || true
echo -n "bot: "; systemctl is-active predict-fun-bot 2>/dev/null || echo "(unit belum ada — abaikan)"
echo "grub:"
grep '^GRUB_CMDLINE_LINUX=' /etc/default/grub
echo
echo "Selesai. Kernel baru berlaku setelah reboot."
echo "BIOS (nanti kalau monitor nyala): Power Management → Deep Sleep = Disable,"
echo "Runtime Power Management = Disable, After Power Loss = Power On."
echo "Paling stabil tanpa layar: dummy plug DisplayPort di belakang PC."
