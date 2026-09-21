'use strict';

const DESKTOP_BREAKPOINT = 1024;
const SCROLL_EDGE_TOLERANCE = 1;

function validateEmailAddress(email, control) {
  if (control && !control.validity.valid) return false;

  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0]) return false;

  const domainParts = parts[1].split('.');
  return domainParts.length >= 2 && domainParts.every((part) => (
    part.length > 0
    && /^[a-z0-9-]+$/i.test(part)
    && !part.startsWith('-')
    && !part.endsWith('-')
  ));
}

function normaliseAustralianPhone(phone) {
  return phone.replace(/[\s()-]/g, '');
}

function validateAustralianPhone(phone) {
  const normalisedPhone = normaliseAustralianPhone(phone);
  return /^(?:04\d{8}|0[2378]\d{8}|\+614\d{8}|\+61[2378]\d{8})$/.test(normalisedPhone);
}

function initMobileNavigation() {
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const mobileNav = document.querySelector('[data-mobile-nav]');

  if (!menuToggle || !mobileNav) {
    return;
  }

  const closeMenu = (returnFocus = false) => {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation menu');
    mobileNav.hidden = true;

    if (returnFocus) {
      menuToggle.focus();
    }
  };

  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';

    if (isOpen) {
      closeMenu();
      return;
    }

    menuToggle.setAttribute('aria-expanded', 'true');
    menuToggle.setAttribute('aria-label', 'Close navigation menu');
    mobileNav.hidden = false;
  });

  mobileNav.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      closeMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !mobileNav.hidden) {
      closeMenu(true);
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth >= DESKTOP_BREAKPOINT && !mobileNav.hidden) {
      closeMenu();
    }
  });
}

function initStickyHeader() {
  const header = document.querySelector('[data-header]');

  if (!header) {
    return;
  }

  const updateHeader = () => {
    header.classList.toggle('is-scrolled', window.scrollY > 0);
  };

  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();
}

function initCarousel(carousel) {
  const track = carousel.querySelector('[data-carousel-track]');
  const previousButton = carousel.querySelector('[data-carousel-previous]');
  const nextButton = carousel.querySelector('[data-carousel-next]');
  const paginationDots = Array.from(carousel.querySelectorAll('[data-carousel-dot]'));

  if (!track || !previousButton || !nextButton || !track.firstElementChild) {
    return null;
  }

  const updateControls = () => {
    const maximumScroll = track.scrollWidth - track.clientWidth;

    previousButton.disabled = track.scrollLeft <= SCROLL_EDGE_TOLERANCE;
    nextButton.disabled = track.scrollLeft >= maximumScroll - SCROLL_EDGE_TOLERANCE;

    if (paginationDots.length) {
      const progress = maximumScroll > 0 ? track.scrollLeft / maximumScroll : 0;
      const activeIndex = Math.round(progress * (paginationDots.length - 1));

      paginationDots.forEach((dot, index) => {
        if (index === activeIndex) {
          dot.setAttribute('aria-current', 'true');
        } else {
          dot.removeAttribute('aria-current');
        }
      });
    }
  };

  const scrollByItem = (direction) => {
    const trackStyles = window.getComputedStyle(track);
    const gap = Number.parseFloat(trackStyles.columnGap) || 0;
    const itemWidth = track.firstElementChild.getBoundingClientRect().width;

    track.scrollBy({
      left: direction * (itemWidth + gap),
      behavior: 'smooth'
    });
  };

  previousButton.addEventListener('click', () => scrollByItem(-1));
  nextButton.addEventListener('click', () => scrollByItem(1));
  paginationDots.forEach((dot, index) => {
    dot.addEventListener('click', () => {
      const item = track.children[index];

      if (!item) {
        return;
      }

      track.scrollTo({
        left: item.offsetLeft - track.firstElementChild.offsetLeft,
        behavior: 'smooth'
      });
    });
  });
  track.addEventListener('scroll', updateControls, { passive: true });
  updateControls();

  return updateControls;
}

function setCurrentYear() {
  const currentYear = document.querySelector('[data-current-year]');

  if (currentYear) {
    currentYear.textContent = new Date().getFullYear();
  }
}

function initModal(modal) {
  const openButtons = Array.from(document.querySelectorAll(`[data-modal-open="${modal.id}"]`));
  const closeButtons = Array.from(modal.querySelectorAll('[data-modal-close]'));
  const dialog = modal.querySelector('[role="dialog"]');
  const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let returnFocusTo = null;

  if (!openButtons.length || !dialog) {
    return;
  }

  const closeModal = () => {
    modal.hidden = true;
    document.body.classList.remove('has-modal-open');
    openButtons.forEach((button) => button.setAttribute('aria-expanded', 'false'));
    returnFocusTo?.focus();
    returnFocusTo = null;
  };

  const openModal = (trigger) => {
    returnFocusTo = trigger;
    modal.hidden = false;
    document.body.classList.add('has-modal-open');
    trigger.setAttribute('aria-expanded', 'true');
    modal.querySelector('.modal__close')?.focus();
  };

  openButtons.forEach((button) => button.addEventListener('click', () => openModal(button)));
  closeButtons.forEach((button) => button.addEventListener('click', closeModal));

  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusableElements = Array.from(dialog.querySelectorAll(focusableSelector));
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (!firstElement || !lastElement) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  });
}

function initDisclosure(disclosure) {
  const trigger = disclosure.querySelector('[data-disclosure-trigger]');
  const panel = disclosure.querySelector('[data-disclosure-panel]');
  const closeButton = disclosure.querySelector('[data-disclosure-close]');

  if (!trigger || !panel) return;

  const setOpen = (isOpen) => {
    trigger.setAttribute('aria-expanded', String(isOpen));
    panel.hidden = !isOpen;

    if (isOpen) {
      panel.querySelector('[data-disclosure-heading]')?.focus({ preventScroll: true });
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      trigger.focus();
    }
  };

  trigger.addEventListener('click', () => setOpen(panel.hidden));
  closeButton?.addEventListener('click', () => setOpen(false));
}

function initInterestForm(form) {
  const status = form.querySelector('[data-interest-status]');
  const confirmation = form.parentElement.querySelector('[data-interest-confirmation]');

  form.querySelectorAll('[data-interest-error]').forEach((error) => {
    const control = form.elements.namedItem(error.dataset.interestError);
    error.id = `interest-${error.dataset.interestError}-error`;
    control?.setAttribute('aria-describedby', error.id);
  });

  const clearError = (control) => {
    const error = form.querySelector(`[data-interest-error="${control.name}"]`);
    if (error) error.textContent = '';
    control.removeAttribute('aria-invalid');
  };

  const setError = (control, message) => {
    const error = form.querySelector(`[data-interest-error="${control.name}"]`);
    if (error) error.textContent = message;
    control.setAttribute('aria-invalid', 'true');
  };

  form.addEventListener('input', (event) => clearError(event.target));
  form.addEventListener('change', (event) => clearError(event.target));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    status.hidden = true;
    form.querySelectorAll('[aria-invalid="true"]').forEach(clearError);
    let firstInvalid = null;

    form.querySelectorAll('input[required]').forEach((control) => {
      let message = '';
      if (!control.validity.valid) message = `Please enter your ${control.labels?.[0]?.textContent.toLowerCase() || 'information'}.`;
      if (control.type === 'email' && !validateEmailAddress(control.value.trim(), control)) message = 'Please enter a valid email address, for example name@example.com.';
      if (control.type === 'tel' && !validateAustralianPhone(control.value.trim())) message = 'Please enter a valid Australian mobile or landline number.';

      if (message) {
        setError(control, message);
        firstInvalid ||= control;
      }
    });

    if (firstInvalid) {
      status.textContent = 'Please check the highlighted information before continuing.';
      status.hidden = false;
      firstInvalid.focus();
      return;
    }

    // Future backend/API and optional resume upload should be connected here.
    form.hidden = true;
    confirmation.hidden = false;
    confirmation.focus();
  });
}

function initGatewayVideos() {
  const pathways = Array.from(document.querySelectorAll('.gateway__panel'), (panel) => ({
    panel,
    video: panel.querySelector('[data-gateway-video]')
  })).filter(({ video }) => video);

  if (!pathways.length) return;

  const hoverPointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let activePathway = null;

  const resetVideo = (video) => {
    video.pause();
    video.currentTime = 0;
  };

  const pauseAll = () => {
    activePathway = null;
    pathways.forEach(({ video }) => resetVideo(video));
  };

  const activate = async (pathway) => {
    if (reducedMotion.matches || document.hidden) return;

    activePathway = pathway;
    pathways.forEach(({ video }) => resetVideo(video));

    try {
      await pathway.video.play();
      // Playback may finish starting after the pointer/focus has already moved.
      if (activePathway !== pathway || reducedMotion.matches || document.hidden) {
        resetVideo(pathway.video);
      }
    } catch {
      // A blocked or interrupted play attempt must never interfere with the link.
    }
  };

  const deactivate = (pathway) => {
    if (activePathway === pathway) activePathway = null;
    resetVideo(pathway.video);
  };

  pathways.forEach((pathway) => {
    const { panel, video } = pathway;
    video.muted = true;
    resetVideo(video);

    panel.addEventListener('pointerenter', (event) => {
      if (hoverPointer.matches && event.pointerType !== 'touch') activate(pathway);
    });
    panel.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'touch') deactivate(pathway);
    });
    panel.addEventListener('focus', () => {
      // Keyboard focus also works with an attached keyboard on a touch device.
      // Pointer/tap focus must not turn navigation into a playback interaction.
      if (panel.matches(':focus-visible')) activate(pathway);
    });
    panel.addEventListener('blur', () => deactivate(pathway));
  });

  reducedMotion.addEventListener('change', pauseAll);
  hoverPointer.addEventListener('change', pauseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAll();
  });
  window.addEventListener('pagehide', pauseAll);
}

function init() {
  initMobileNavigation();
  initStickyHeader();
  initGatewayVideos();

  const carouselUpdates = Array.from(
    document.querySelectorAll('[data-carousel]'),
    initCarousel
  ).filter(Boolean);

  if (carouselUpdates.length) {
    window.addEventListener('resize', () => {
      carouselUpdates.forEach((updateControls) => updateControls());
    });
  }

  document.querySelectorAll('[data-modal]').forEach(initModal);
  document.querySelectorAll('[data-disclosure]').forEach(initDisclosure);
  document.querySelectorAll('[data-interest-form]').forEach(initInterestForm);

  setCurrentYear();
}

init();
