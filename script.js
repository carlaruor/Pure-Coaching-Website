'use strict';

const DESKTOP_BREAKPOINT = 1024;
const SCROLL_EDGE_TOLERANCE = 1;

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

function init() {
  initMobileNavigation();
  initStickyHeader();

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

  setCurrentYear();
}

init();
