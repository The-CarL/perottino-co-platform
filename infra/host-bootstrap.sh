#!/bin/bash
set -eu
# Rendered by CDK using the stack's ECS cluster name and exact EBS volume ID.
install -d -m 0755 /etc/ecs /etc/systemd/system/ecs.service.d
cat >> /etc/ecs/ecs.config <<'AGENT'
ECS_CLUSTER=@@CLUSTER@@
ECS_RESERVED_MEMORY=384
ECS_CONTAINER_INSTANCE_TAGS=@@INSTANCE_TAGS@@
ECS_ENABLE_TASK_IAM_ROLE=true
ECS_ENABLE_AWSLOGS_EXECUTIONROLE_OVERRIDE=true
ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=false
AGENT
cat > /usr/local/sbin/perottino-storage <<'STORAGE'
#!/bin/bash
set -eu
volume='@@VOLUME@@'
serial=${volume//-/}
disk="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${serial}"
for attempt in {1..180}; do
  [ ! -b "$disk" ] || break
  # Nitro kernels expose the exact EBS volume serial even when udev emits no by-id link.
  name=$(lsblk -dn -o NAME,SERIAL | awk -v serial="$serial" '$2 == serial {print $1}')
  if [ -n "$name" ] && [ -b "/dev/$name" ]; then disk="/dev/$name"; break; fi
  sleep 2
done
[ -b "$disk" ] || { echo "Expected EBS device missing"; exit 1; }
kind=$(blkid -p -s TYPE -o value "$disk" || true)
if [ -z "$kind" ]; then
  [ '@@ALLOW_FORMAT@@' = yes ] || { echo "Restored volume has no ext4 filesystem"; exit 1; }
  # An unrecognized or corrupt filesystem is never reformatted. Check the complete new disk.
  cmp --silent -n "$(blockdev --getsize64 "$disk")" /dev/zero "$disk" || { echo "Unrecognized nonempty disk"; exit 1; }
  mkfs.ext4 -q "$disk"
elif [ "$kind" != ext4 ]; then
  echo "Unexpected volume filesystem"
  exit 1
fi
root=/var/lib/perottino-host
install -d -m 0755 "$root"
if ! mountpoint -q "$root"; then mount -o nodev,nosuid "$disk" "$root"; fi
[ "$(findmnt -n -o MAJ:MIN --mountpoint "$root")" = "$(lsblk -dn -o MAJ:MIN "$disk" | tr -d ' ')" ]
install -d -o 1000 -g 1000 -m 0700 "$root/company" /run/perottino-worker /run/perottino-render
install -d -m 0700 "$root/proxy"
# EC2 instance metadata and its host role remain inaccessible from bridge tasks.
if ! iptables -C DOCKER-USER -i docker+ -d 169.254.169.254/32 -j DROP 2>/dev/null; then
  iptables -I DOCKER-USER 1 -i docker+ -d 169.254.169.254/32 -j DROP
fi
# Only a host that has verified this exact volume may receive the company's tasks.
sed -i '/^ECS_INSTANCE_ATTRIBUTES=/d' /etc/ecs/ecs.config
printf 'ECS_INSTANCE_ATTRIBUTES={"company-volume":"%s"}\n' "$volume" >> /etc/ecs/ecs.config
STORAGE
chmod 0755 /usr/local/sbin/perottino-storage
cat > /etc/systemd/system/perottino-storage.service <<'UNIT'
[Unit]
Description=Mount the verified company volume and prepare local worker IPC
After=docker.service
Requires=docker.service
Before=ecs.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/perottino-storage
RemainAfterExit=yes
TimeoutStartSec=@@BOOT_TIMEOUT@@
UNIT
cat > /etc/systemd/system/ecs.service.d/storage.conf <<'UNIT'
[Unit]
Requires=perottino-storage.service
After=perottino-storage.service
UNIT
systemctl daemon-reload
# Do not synchronously wait for ecs.service while cloud-final.service is running.
systemctl enable ecs.service
systemctl start --no-block ecs.service
