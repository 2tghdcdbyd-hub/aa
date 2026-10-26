let blockedUsers = [],
  reportTarget = null,
  safetyGeneration = 0;
function isBlocked(id) {
  return blockedUsers.some((user) => user.id === id);
}
function clearSafetyState() {
  safetyGeneration++;
  blockedUsers = [];
  reportTarget = null;
  for (const id of [
    "safety-dialog",
    "report-dialog",
    "recovery-code-dialog",
    "recover-dialog",
  ])
    if ($("#" + id).open) $("#" + id).close();
  $("#recovery-code-value").textContent = "";
  $("#recovery-code-form").reset();
  $("#report-form").reset();
  $("#blocked-users").replaceChildren();
  $("#my-reports").replaceChildren();
}
async function refreshSafety() {
  const epoch = generation,
    version = safetyGeneration;
  const [blocks, reports] = await Promise.all([
    chatRequest("blocks"),
    chatRequest("reports"),
  ]);
  if (epoch !== generation || version !== safetyGeneration) return;
  setBlockedUsers(blocks.blocks);
  const statuses = {
    open: "검토 대기",
    resolved: "처리 완료",
    dismissed: "종결",
  };
  $("#my-reports").replaceChildren();
  for (const report of reports.reports)
    $("#my-reports").append(
      element(
        "p",
        "report-status",
        report.reported_name +
          " · " +
          statuses[report.status] +
          " · " +
          report.id.slice(0, 8),
      ),
    );
  if (!reports.reports.length)
    $("#my-reports").append(element("p", "", "접수한 신고가 없습니다."));
  renderMembers();
}
function setBlockedUsers(users) {
  blockedUsers = users;
  const list = $("#blocked-users");
  list.replaceChildren();
  for (const user of blockedUsers) {
    const row = element("div", "safety-row", user.name);
    const remove = element("button", "", "차단 해제");
    remove.onclick = () => toggleBlock(user);
    row.append(remove);
    list.append(row);
  }
  if (!blockedUsers.length)
    list.append(element("p", "", "차단한 사용자가 없습니다."));
}
$("#safety-settings").onclick = async () => {
  $("#safety-error").textContent = "";
  $("#safety-dialog").showModal();
  try {
    await refreshSafety();
  } catch (error) {
    $("#safety-error").textContent = error.message;
  }
};
$("#recovery-code-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector("button"),
    epoch = generation;
  button.disabled = true;
  $("#safety-error").textContent = "";
  try {
    const result = await chatRequest(
      "recovery-code",
      Object.fromEntries(new FormData(form)),
    );
    if (epoch !== generation) return;
    form.reset();
    showRecoveryCode(result.recoveryCode);
  } catch (error) {
    if (epoch === generation) $("#safety-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
async function toggleBlock(user) {
  const remove = isBlocked(user.id),
    epoch = generation;
  if (
    !confirm(
      remove
        ? user.name + "님의 차단을 해제할까요?"
        : user.name +
            "님을 차단할까요? 친구 목록에서 삭제하며 서로의 대화·메시지 전송을 제한합니다. 같은 단체방에서도 전송이 제한됩니다.",
    )
  )
    return;
  try {
    await chatRequest(remove ? "blocks/remove" : "blocks", { userId: user.id });
    if (epoch !== generation) return;
    await refreshSafety();
    await synchronize();
  } catch (error) {
    if (epoch === generation) {
      $("#safety-error").textContent = error.message;
      chatError(error.message);
    }
  }
}
function openReport(target) {
  reportTarget = target;
  $("#report-form").reset();
  $("#report-error").textContent = "";
  $("#report-target-name").textContent =
    target.name + (target.messageId ? "님의 메시지 신고" : "님 사용자 신고");
  $("#report-dialog").showModal();
}
$("#report-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!reportTarget) return;
  const button = event.currentTarget.querySelector("button"),
    epoch = generation;
  const data = {
    ...Object.fromEntries(new FormData(event.currentTarget)),
    userId: reportTarget.userId,
    ...(reportTarget.messageId ? { messageId: reportTarget.messageId } : {}),
  };
  button.disabled = true;
  try {
    const result = await chatRequest("reports", data);
    if (epoch !== generation) return;
    $("#report-error").textContent =
      "신고가 접수되었습니다. 운영자 검토 대기 중입니다. 접수 번호: " +
      result.report.id;
  } catch (error) {
    if (epoch === generation) $("#report-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$("#safety-dialog").addEventListener("close", () =>
  $("#recovery-code-form").reset(),
);
