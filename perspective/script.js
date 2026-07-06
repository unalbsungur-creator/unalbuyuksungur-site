/**
 * ============================================================
 * Stress Decision Game - Main JavaScript
 * Pure Vanilla JavaScript (ES6+)
 * No external libraries
 * ============================================================
 */

(function () {
    'use strict';

    /*
    ============================================================
    GAME STATE MANAGEMENT
    ============================================================
    */
    const GameState = {
        /** Answer to question 1: 'yes' | 'no' | null */
        q1Answer: null,
        /** Answer to question 2: 'yes' | 'no' | null */
        q2Answer: null,
        /** Current active screen ID */
        currentScreen: 'screen-q1',
        /** Is transition in progress */
        isTransitioning: false
    };

    /*
    ============================================================
    DOM ELEMENT REFERENCES
    ============================================================
    */
    const DOM = {
        app: null,
        starfield: null,
        neonGrid: null,
        mouseLight: null,
        screens: {
            q1: null,
            q2: null,
            final: null
        },
        finalMessage: null,
        finalContent: null,
        analysisSequence: null,
        analysisStatus: null,
        analysisProgressFill: null,
        replayBtn: null,
        glassCards: [],
        buttons: [],
        orbs: []
    };

    /*
    ============================================================
    CANVAS & STARFIELD CONFIGURATION
    ============================================================
    */
    const Starfield = {
        canvas: null,
        ctx: null,
        stars: [],
        starCount: 300,
        animationId: null,
        /** Parallax offset from mouse */
        offsetX: 0,
        offsetY: 0
    };

    /*
    ============================================================
    SOUND MANAGER
    Handles audio playback with graceful fallback
    ============================================================
    */
    const SoundManager = {
        /** Cache for audio objects */
        cache: {},
        /** Base path for audio assets */
        basePath: 'assets/',

        /**
         * Initialize sound manager
         * Preloads audio files silently
         */
        init() {
            this.cache.pop = this._loadAudio('pop.mp3');
            this.cache.ding = this._loadAudio('ding.mp3');
        },

        /**
         * Load an audio file with error handling
         * @param {string} filename - Audio filename
         * @returns {HTMLAudioElement|null}
         */
        _loadAudio(filename) {
            try {
                const audio = new Audio(this.basePath + filename);
                audio.preload = 'auto';
                audio.volume = 0.4;
                // Suppress errors if file doesn't exist
                audio.addEventListener('error', () => {
                    console.warn(`[SoundManager] Could not load: ${filename}`);
                });
                return audio;
            } catch (e) {
                console.warn(`[SoundManager] Audio creation failed: ${filename}`);
                return null;
            }
        },

        /**
         * Play a sound by name
         * @param {string} name - Sound name ('pop' | 'ding')
         */
        play(name) {
            const audio = this.cache[name];
            if (audio && audio.readyState >= 2) {
                // Reset to start for rapid clicks
                audio.currentTime = 0;
                audio.play().catch(() => {
                    // Autoplay policy may block - silently fail
                });
            }
        }
    };

    /*
    ============================================================
    STARFIELD ENGINE
    Creates and animates 300 stars on canvas
    ============================================================
    */
    function initStarfield() {
        Starfield.canvas = DOM.starfield;
        Starfield.ctx = Starfield.canvas.getContext('2d');

        // Set canvas size to match window
        resizeCanvas();

        // Generate stars
        generateStars();

        // Start animation loop
        animateStars();

        // Handle window resize
        window.addEventListener('resize', debounce(resizeCanvas, 200));
    }

    /**
     * Resize canvas to window dimensions
     */
    function resizeCanvas() {
        Starfield.canvas.width = window.innerWidth;
        Starfield.canvas.height = window.innerHeight;
        // Regenerate stars on resize to fill new area
        generateStars();
    }

    /**
     * Generate star array with random properties
     */
    function generateStars() {
        Starfield.stars = [];
        const w = Starfield.canvas.width;
        const h = Starfield.canvas.height;

        for (let i = 0; i < Starfield.starCount; i++) {
            Starfield.stars.push({
                // Position
                x: Math.random() * w,
                y: Math.random() * h,
                // Size: most stars small, some larger
                radius: Math.random() < 0.1 ? Math.random() * 2 + 1.5 : Math.random() * 1.2 + 0.3,
                // Brightness variation
                opacity: Math.random() * 0.7 + 0.3,
                // Twinkle speed
                twinkleSpeed: Math.random() * 0.02 + 0.005,
                twinkleOffset: Math.random() * Math.PI * 2,
                // Movement speed (parallax depth)
                speedX: (Math.random() - 0.5) * 0.15,
                speedY: (Math.random() - 0.5) * 0.15,
                // Depth layer (affects parallax intensity)
                depth: Math.random() * 0.5 + 0.5,
                // Color: mostly white, some cyan/violet tinted
                color: Math.random() < 0.85
                    ? '255, 255, 255'
                    : Math.random() < 0.5
                        ? '111, 216, 224'
                        : '154, 147, 214'
            });
        }
    }

    /**
     * Main star animation loop
     */
    function animateStars() {
        const ctx = Starfield.ctx;
        const w = Starfield.canvas.width;
        const h = Starfield.canvas.height;
        const time = Date.now() * 0.001;

        // Clear canvas
        ctx.clearRect(0, 0, w, h);

        // Draw each star
        for (let i = 0; i < Starfield.stars.length; i++) {
            const star = Starfield.stars[i];

            // Update position (slow drift)
            star.x += star.speedX;
            star.y += star.speedY;

            // Wrap around edges
            if (star.x < -5) star.x = w + 5;
            if (star.x > w + 5) star.x = -5;
            if (star.y < -5) star.y = h + 5;
            if (star.y > h + 5) star.y = -5;

            // Apply parallax offset
            const px = star.x + Starfield.offsetX * star.depth;
            const py = star.y + Starfield.offsetY * star.depth;

            // Twinkle effect using sine wave
            const twinkle = Math.sin(time * star.twinkleSpeed * 60 + star.twinkleOffset);
            const currentOpacity = star.opacity * (0.6 + twinkle * 0.4);

            // Draw star
            ctx.beginPath();
            ctx.arc(px, py, star.radius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${star.color}, ${currentOpacity})`;
            ctx.fill();

            // Add glow to larger stars
            if (star.radius > 1.5) {
                ctx.beginPath();
                ctx.arc(px, py, star.radius * 3, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${star.color}, ${currentOpacity * 0.15})`;
                ctx.fill();
            }
        }

        Starfield.animationId = requestAnimationFrame(animateStars);
    }

    /*
    ============================================================
    MOUSE PARALLAX & LIGHT EFFECT
    ============================================================
    */
    function initMouseEffects() {
        const mouseLight = DOM.mouseLight;

        document.addEventListener('mousemove', (e) => {
            const x = e.clientX;
            const y = e.clientY;

            // Update mouse-following light
            mouseLight.style.left = x + 'px';
            mouseLight.style.top = y + 'px';
            mouseLight.classList.add('active');

            // Calculate parallax offset (center-relative, normalized)
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;
            Starfield.offsetX = (x - centerX) * 0.02;
            Starfield.offsetY = (y - centerY) * 0.02;

            // Move parallax orbs
            moveOrbs(x, y);

            // Update button mouse light positions
            updateButtonMouseLight(e);
        });

        // Hide light when mouse leaves window
        document.addEventListener('mouseleave', () => {
            mouseLight.classList.remove('active');
        });
    }

    /**
     * Move floating orbs based on mouse position
     * @param {number} x - Mouse X
     * @param {number} y - Mouse Y
     */
    function moveOrbs(x, y) {
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const dx = (x - centerX) / centerX;
        const dy = (y - centerY) / centerY;

        DOM.orbs.forEach((orb, index) => {
            const factor = (index + 1) * 15;
            const moveX = dx * factor;
            const moveY = dy * factor;
            orb.style.transform = `translate(${moveX}px, ${moveY}px)`;
        });
    }

    /**
     * Update CSS custom properties for button mouse light effect
     * @param {MouseEvent} e
     */
    function updateButtonMouseLight(e) {
        DOM.buttons.forEach(btn => {
            const rect = btn.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            btn.style.setProperty('--mouse-x', x + 'px');
            btn.style.setProperty('--mouse-y', y + 'px');
        });
    }

    /*
    ============================================================
    MAGNETIC BUTTONS
    Subtle pull toward the cursor - reinforces precision and
    quality of touch rather than calling attention to itself.
    ============================================================
    */
    function initMagneticButtons() {
        const MAX_PULL = 10; // px, deliberately restrained
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (prefersReducedMotion) return;

        DOM.buttons.forEach(btn => {
            btn.addEventListener('mousemove', (e) => {
                const rect = btn.getBoundingClientRect();
                const relX = (e.clientX - rect.left) / rect.width - 0.5;
                const relY = (e.clientY - rect.top) / rect.height - 0.5;
                btn.style.setProperty('--magnet-x', (relX * MAX_PULL).toFixed(2) + 'px');
                btn.style.setProperty('--magnet-y', (relY * MAX_PULL).toFixed(2) + 'px');
            });

            btn.addEventListener('mouseleave', () => {
                btn.style.setProperty('--magnet-x', '0px');
                btn.style.setProperty('--magnet-y', '0px');
            });
        });
    }

    /*
    ============================================================
    GLASS CARD TILT EFFECT
    3D perspective tilt on mouse hover
    ============================================================
    */
    function initCardTilt() {
        DOM.glassCards.forEach(card => {
            card.addEventListener('mousemove', (e) => {
                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;

                // Calculate rotation (max 8 degrees)
                const rotateX = ((y - centerY) / centerY) * -8;
                const rotateY = ((x - centerX) / centerX) * 8;

                card.style.setProperty('--tilt-x', rotateX + 'deg');
                card.style.setProperty('--tilt-y', rotateY + 'deg');
                card.classList.add('tilt');
            });

            card.addEventListener('mouseleave', () => {
                card.classList.remove('tilt');
                card.style.setProperty('--tilt-x', '0deg');
                card.style.setProperty('--tilt-y', '0deg');
            });
        });
    }

    /*
    ============================================================
    BUTTON RIPPLE EFFECT
    Material Design-style ripple on click
    ============================================================
    */
    function initButtonRipple() {
        DOM.buttons.forEach(btn => {
            btn.addEventListener('click', function (e) {
                const ripple = this.querySelector('.btn-ripple');
                if (!ripple) return;

                const rect = this.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height);
                const x = e.clientX - rect.left - size / 2;
                const y = e.clientY - rect.top - size / 2;

                ripple.style.width = size + 'px';
                ripple.style.height = size + 'px';
                ripple.style.left = x + 'px';
                ripple.style.top = y + 'px';

                // Reset animation
                ripple.style.animation = 'none';
                ripple.offsetHeight; // Trigger reflow
                ripple.style.animation = 'rippleEffect 0.6s linear';
            });
        });
    }

    /*
    ============================================================
    SCREEN TRANSITION SYSTEM
    Smooth fade + scale + blur transitions between screens
    ============================================================
    */
    /**
     * Transition from current screen to target screen
     * @param {string} targetId - Target screen element ID
     */
    function transitionToScreen(targetId) {
        if (GameState.isTransitioning || targetId === GameState.currentScreen) return;
        GameState.isTransitioning = true;

        const currentEl = document.getElementById(GameState.currentScreen);
        const targetEl = document.getElementById(targetId);

        if (!currentEl || !targetEl) {
            GameState.isTransitioning = false;
            return;
        }

        // Phase 1: Fade out current screen
        currentEl.classList.add('fade-out');

        setTimeout(() => {
            // Deactivate current screen
            currentEl.classList.remove('active', 'fade-out');
            currentEl.style.display = 'none';

            // Phase 2: Show and animate target screen
            targetEl.style.display = '';
            targetEl.classList.add('active', 'fade-in');

            GameState.currentScreen = targetId;

            // Reaching the final screen triggers the quiet system
            // analysis readout before the real message is revealed.
            if (targetId === 'screen-final') {
                runAnalysisSequence(() => {
                    if (DOM.finalContent) {
                        DOM.finalContent.classList.add('revealed');
                    }
                });
            }

            // Clean up animation class
            setTimeout(() => {
                targetEl.classList.remove('fade-in');
                GameState.isTransitioning = false;
            }, 500);
        }, 400);
    }

    /*
    ============================================================
    SYSTEM ANALYSIS SEQUENCE
    A short, quiet instrument readout shown on the final screen
    before the actual message is revealed. Purely additive: it
    does not alter how q1Answer / q2Answer are decided, only
    what happens visually right before setFinalMessage's content
    becomes visible.
    ============================================================
    */
    function runAnalysisSequence(onComplete) {
        const seq = DOM.analysisSequence;
        const statusEl = DOM.analysisStatus;
        const fill = DOM.analysisProgressFill;

        if (!seq || !statusEl || !fill) {
            onComplete();
            return;
        }

        const steps = ['Taranıyor', 'Değerlendiriliyor', 'İşleniyor', 'Tamamlandı'];
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        seq.classList.add('active');

        if (prefersReducedMotion) {
            statusEl.textContent = steps[steps.length - 1];
            fill.style.transform = 'scaleX(1)';
            setTimeout(() => {
                seq.classList.remove('active');
                onComplete();
            }, 200);
            return;
        }

        fill.style.transform = 'scaleX(0)';
        let index = 0;

        function nextStep() {
            statusEl.textContent = steps[index];
            fill.style.transform = `scaleX(${(index + 1) / steps.length})`;
            index++;

            if (index < steps.length) {
                setTimeout(nextStep, 420);
            } else {
                setTimeout(() => {
                    seq.classList.remove('active');
                    onComplete();
                }, 550);
            }
        }

        setTimeout(nextStep, 250);
    }

    /**
     * Reset the analysis sequence and hidden final content back
     * to their initial state, ready for the next playthrough.
     */
    function resetAnalysisSequence() {
        const seq = DOM.analysisSequence;
        const fill = DOM.analysisProgressFill;

        if (seq) seq.classList.remove('active');
        if (fill) fill.style.transform = 'scaleX(0)';
        if (DOM.finalContent) DOM.finalContent.classList.remove('revealed');
    }

    /*
    ============================================================
    GAME FLOW LOGIC
    ============================================================
    */
    function initGameFlow() {
        // Question 1 buttons
        const q1Buttons = document.querySelectorAll('[data-question="1"]');
        q1Buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const answer = btn.dataset.answer;
                GameState.q1Answer = answer;
                SoundManager.play('pop');

                if (answer === 'yes') {
                    // Go to question 2
                    setTimeout(() => transitionToScreen('screen-q2'), 300);
                } else {
                    // Skip to final screen
                    setTimeout(() => {
                        setFinalMessage('no');
                        transitionToScreen('screen-final');
                    }, 300);
                }
            });
        });

        // Question 2 buttons
        const q2Buttons = document.querySelectorAll('[data-question="2"]');
        q2Buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const answer = btn.dataset.answer;
                GameState.q2Answer = answer;
                SoundManager.play('pop');

                // Both answers lead to final screen
                setTimeout(() => {
                    setFinalMessage('yes');
                    transitionToScreen('screen-final');
                }, 300);
            });
        });

        // Replay button
        DOM.replayBtn.addEventListener('click', () => {
            SoundManager.play('ding');
            resetGame();
        });
    }

    /**
     * Set the final screen message based on Q1 answer
     * @param {string} q1Answer - 'yes' or 'no'
     */
    function setFinalMessage(q1Answer) {

        alert("BURASI ÇALIŞIYOR");

        const messageEl = document.getElementById("final-message");
        const titleEl = document.getElementById("final-title");

        if (q1Answer === "yes") {

            titleEl.textContent = "Neden üzülüyorsun?";

            messageEl.innerHTML = `
            Hayatta her problemin bir çözümü vardır.<br><br>

            Çözemediğin şeyler için üzülmek yerine
            <strong>çözebileceklerine odaklan.</strong>
        `;

        } else {

            titleEl.textContent = "Bugün Güzel Bir Gün";

            messageEl.innerHTML = `
    Görünüşe göre şu anda seni gerçekten üzecek
    bir problem yok.<br><br>

    <strong>Bu güzel bir haber.</strong><br><br>

    Bugünün tadını çıkar ve
    küçük mutlulukları fark etmeyi unutma.
`;

        }

    }

    /**
     * Reset game state and return to first question
     */
    function resetGame() {
        GameState.q1Answer = null;
        GameState.q2Answer = null;

        // Reset the analysis readout / hidden final content
        resetAnalysisSequence();

        // Hide all screens
        Object.values(DOM.screens).forEach(screen => {
            screen.classList.remove('active', 'fade-in', 'fade-out');
            screen.style.display = 'none';
        });

        // Show first question
        setTimeout(() => {
            DOM.screens.q1.style.display = '';
            DOM.screens.q1.classList.add('active', 'fade-in');
            GameState.currentScreen = 'screen-q1';

            setTimeout(() => {
                DOM.screens.q1.classList.remove('fade-in');
            }, 500);
        }, 300);
    }

    /*
    ============================================================
    UTILITY FUNCTIONS
    ============================================================
    */

    /**
     * Debounce function to limit execution frequency
     * @param {Function} func - Function to debounce
     * @param {number} wait - Wait time in ms
     * @returns {Function}
     */
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /*
    ============================================================
    INITIALIZATION
    Cache all DOM elements and start the app
    ============================================================
    */
    function init() {
        // Cache DOM elements
        DOM.app = document.getElementById('app');
        DOM.starfield = document.getElementById('starfield');
        DOM.neonGrid = document.getElementById('neon-grid');
        DOM.mouseLight = document.getElementById('mouse-light');
        DOM.screens.q1 = document.getElementById('screen-q1');
        DOM.screens.q2 = document.getElementById('screen-q2');
        DOM.screens.final = document.getElementById('screen-final');
        DOM.finalMessage = document.getElementById('final-message');
        DOM.finalContent = document.getElementById('final-content');
        DOM.analysisSequence = document.getElementById('analysis-sequence');
        DOM.analysisStatus = document.getElementById('analysis-status');
        DOM.analysisProgressFill = document.getElementById('analysis-progress-fill');
        DOM.replayBtn = document.getElementById('replay-btn');
        DOM.glassCards = Array.from(document.querySelectorAll('.glass-card'));
        DOM.buttons = Array.from(document.querySelectorAll('.neon-btn'));
        DOM.orbs = Array.from(document.querySelectorAll('.parallax-orb'));

        // Initialize systems
        SoundManager.init();
        initStarfield();
        initMouseEffects();
        initMagneticButtons();
        initCardTilt();
        initButtonRipple();
        initGameFlow();

        // Hide non-active screens initially
        DOM.screens.q2.style.display = 'none';
        DOM.screens.final.style.display = 'none';

        console.log('[Stress Decision Game] Initialized successfully');
    }

    /*
    ============================================================
    START APPLICATION
    Wait for DOM to be fully loaded
    ============================================================
    */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
