let selectedAttachment = null,
  attachmentRequest = null;
function fileSize(bytes) {
  return bytes < 1024
    ? bytes + " B"
    : bytes < 1024 ** 2
      ? (bytes / 1024).toFixed(1) + " KB"
      : (bytes / 1024 ** 2).toFixed(1) + " MB";
}
function clearAttachment() {
  const request = attachmentRequest;
  attachmentRequest = null;
  request?.abort();
  selectedAttachment = null;
  $("#file-input").value = "";
  $("#attachment-preview").hidden = true;
  $("#attachment-progress").textContent = "";
}
function updateAttachmentControls() {
  const restricted = !current() || current().send_restricted;
  $("#attach-file").disabled = restricted || !!attachmentRequest;
  $("#send-attachment").disabled =
    restricted || !!attachmentRequest || !selectedAttachment;
}
$("#attach-file").onclick = () => {
  if (current() && !current().send_restricted) $("#file-input").click();
};
$("#file-input").onchange = () => {
  const file = $("#file-input").files[0];
  if (!file) return;
  if (!current() || current().send_restricted) {
    $("#file-input").value = "";
    return;
  }
  if (!file.size || file.size > 20 * 1024 ** 2) {
    chatError("파일은 0바이트보다 크고 20MB 이하여야 합니다.");
    $("#file-input").value = "";
    return;
  }
  selectedAttachment = {
    file,
    conversationId: active,
    clientId: crypto.randomUUID(),
  };
  $("#attachment-name").textContent = file.name + " · " + fileSize(file.size);
  $("#attachment-preview").hidden = false;
  $("#attachment-progress").textContent = "전송할 파일을 확인하세요.";
  chatError();
  updateAttachmentControls();
};
$("#cancel-attachment").onclick = () => {
  clearAttachment();
  updateAttachmentControls();
};
$("#send-attachment").onclick = async () => {
  if (
    !selectedAttachment ||
    attachmentRequest ||
    selectedAttachment.conversationId !== active ||
    current()?.send_restricted
  )
    return;
  const selected = selectedAttachment,
    epoch = generation,
    id = active,
    xhr = new XMLHttpRequest();
  attachmentRequest = xhr;
  updateAttachmentControls();
  $("#attachment-progress").textContent = "전송 준비 중…";
  try {
    const result = await new Promise((resolve, reject) => {
      xhr.open("POST", `/api/conversations/${id}/files`);
      xhr.withCredentials = true;
      xhr.timeout = 120000;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader(
        "X-File-Name",
        encodeURIComponent(selected.file.name),
      );
      xhr.setRequestHeader("X-Client-Id", selected.clientId);
      xhr.upload.onprogress = (event) => {
        if (epoch === generation && attachmentRequest === xhr)
          $("#attachment-progress").textContent = event.lengthComputable
            ? Math.round((event.loaded / event.total) * 100) + "% 전송 중…"
            : "전송 중…";
      };
      xhr.onerror = () => reject(Error("연결을 확인한 뒤 다시 전송해 주세요."));
      xhr.ontimeout = () =>
        reject(Error("전송 시간이 초과되었습니다. 다시 시도해 주세요."));
      xhr.onabort = () => reject(Error("파일 전송을 취소했습니다."));
      xhr.onload = () => {
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          reject(Error("서버 응답을 확인할 수 없습니다."));
          return;
        }
        if (xhr.status === 401 && epoch === generation) expireAccount();
        if (xhr.status < 200 || xhr.status >= 300)
          reject(Error(data.error || "파일 전송에 실패했습니다."));
        else resolve(data);
      };
      xhr.send(selected.file);
    });
    if (epoch !== generation) return;
    if (active === id) {
      const history = histories.get(id);
      if (history) {
        const merged = new Map(history.messages.map((m) => [m.id, m]));
        merged.set(result.message.id, result.message);
        history.messages = [...merged.values()].sort((a, b) => a.id - b.id);
        renderMessages({ bottom: true });
      }
    }
    if (selectedAttachment === selected) {
      attachmentRequest = null;
      clearAttachment();
    }
    synchronize();
  } catch (error) {
    if (epoch === generation && selectedAttachment === selected)
      $("#attachment-progress").textContent = error.message;
  } finally {
    if (epoch === generation && attachmentRequest === xhr)
      attachmentRequest = null;
    if (epoch === generation) updateAttachmentControls();
  }
};

async function downloadAttachment(event, file) {
  event.preventDefault();
  const epoch = generation;
  try {
    const url = "/api/files/" + encodeURIComponent(file.id),
      response = await fetch(url, {
        method: "HEAD",
        credentials: "same-origin",
      });
    if (epoch !== generation) return;
    if (response.status === 401) {
      expireAccount();
      return;
    }
    if (!response.ok)
      throw Error(
        response.status === 404
          ? "파일을 찾을 수 없거나 다운로드 권한이 없습니다."
          : "파일을 다운로드할 수 없습니다. 운영자에게 문의해 주세요.",
      );
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    if (epoch === generation)
      chatError(error.message || "다운로드 연결에 실패했습니다.");
  }
}
