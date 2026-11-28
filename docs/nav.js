/* 뒤로 가기 지원: 종목 상세·업종 창·탭 이동을 브라우저 방문 기록(history)에 쌓는다.
   - 창을 열 때마다 기록 1개 추가 → 휴대폰 뒤로 가기 = 바로 전 화면
   - X·바깥 영역·Esc = 열린 창을 모두 닫고 창을 열기 전 화면으로
   app.js · detail.js · sector.js 의 openDetail / openSector / closeDetail / switchTab 을 감싼다 (반드시 마지막에 로드). */
(function () {
  const o = { detail: window.openDetail, sector: window.openSector, close: window.closeDetail, tab: window.switchTab };
  let restoring = false, started = false;
  const isOpen = () => document.getElementById("detail")?.classList.contains("on");
  const curTab = () => document.querySelector(".tabs button.on")?.dataset.tab || null;
  const depth = () => (history.state && history.state.n) || 0;
  const push = st => { if (!restoring) history.pushState(st, ""); };

  window.openDetail = function (code, opt) {
    push({ v: "detail", code, back: (opt && opt.back) || null, tab: curTab(), n: depth() + 1 });
    return o.detail(code, opt);
  };
  if (o.sector) window.openSector = function (name) {
    push({ v: "sector", name, tab: curTab(), n: depth() + 1 });
    return o.sector(name);
  };
  window.switchTab = function (id) {
    if (!started) {  // 첫 화면: 기록을 늘리지 않고 현재 기록을 탭 상태로 맞춤 (새로고침 시 남은 창 기록 정리)
      started = true;
      history.replaceState({ v: "tab", tab: id, n: 0 }, "");
    } else if (!restoring) {
      if (isOpen()) o.close();
      if (id !== curTab()) history.pushState({ v: "tab", tab: id, n: 0 }, "");
    }
    return o.tab(id);
  };
  window.closeDetail = function () {
    const n = depth();
    if (!restoring && n > 0) history.go(-n);  // popstate 에서 실제로 닫힘
    else o.close && o.close();
  };

  addEventListener("popstate", e => {
    const s = e.state;
    restoring = true;
    try {
      if (!s || s.v === "tab") {
        if (isOpen()) o.close();
        if (s && s.tab && s.tab !== curTab()) o.tab(s.tab);
      } else {
        if (s.tab && s.tab !== curTab()) o.tab(s.tab);
        if (s.v === "detail") o.detail(s.code, s.back ? { back: s.back } : undefined);
        else if (s.v === "sector" && o.sector) o.sector(s.name);
      }
    } finally {
      restoring = false;
    }
  });

  // X 버튼·바깥 영역 클릭을 이 파일의 closeDetail 로 연결 (Esc 는 전역 closeDetail 을 호출하므로 자동 적용)
  const bind = () => {
    const b = document.getElementById("closeDetail"); if (b) b.onclick = window.closeDetail;
    const sc = document.getElementById("scrim"); if (sc) sc.onclick = window.closeDetail;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
})();
