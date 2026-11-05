/* Görev 231: "Müzik Stüdyosu" alt paneli — aria-expanded eşitlemesi, dokunmatikte ilk dokunuşla açma, Esc ile kapatma.
   Hover ve klavye odağı (focus-within) CSS ile çalışır; bu betik yalnızca eksik davranışları tamamlar. */
(function () {
    "use strict";
    var desktop = window.matchMedia("(min-width: 861px)");

    document.querySelectorAll(".nav-has-sub").forEach(function (item) {
        var trigger = item.querySelector(".nav-sub-trigger");
        var touch = false;
        if (!trigger) return;

        function sync() {
            var open = !desktop.matches || (!item.classList.contains("is-dismissed") &&
                (item.classList.contains("is-open") || item.matches(":hover") || item.contains(document.activeElement)));
            trigger.setAttribute("aria-expanded", String(open));
        }

        function reset() {
            item.classList.remove("is-open", "is-dismissed");
            sync();
        }

        item.addEventListener("mouseenter", sync);
        item.addEventListener("mouseleave", reset);
        item.addEventListener("focusin", sync);
        item.addEventListener("focusout", function () {
            window.setTimeout(function () {
                if (!item.contains(document.activeElement)) reset();
            }, 0);
        });

        trigger.addEventListener("pointerdown", function (event) {
            touch = event.pointerType === "touch" || event.pointerType === "pen";
        });
        trigger.addEventListener("click", function (event) {
            // Dokunmatik masaüstü düzeninde ilk dokunuş paneli açar, ikinci dokunuş bağlantıya gider.
            if (desktop.matches && touch && !item.classList.contains("is-open")) {
                event.preventDefault();
                item.classList.remove("is-dismissed");
                item.classList.add("is-open");
                sync();
            }
            touch = false;
        });

        item.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && desktop.matches && trigger.getAttribute("aria-expanded") === "true") {
                event.stopPropagation();
                item.classList.remove("is-open");
                item.classList.add("is-dismissed");
                trigger.focus();
                sync();
            }
        });

        document.addEventListener("click", function (event) {
            if (!item.contains(event.target)) reset();
        });
        if (desktop.addEventListener) desktop.addEventListener("change", reset);
        sync();
    });
})();
