fetch('./js/swiper-bundle.min.js').then(r => { return r.text() }).then(t => {
let tag=['14,400 years ago','6,000 B.C.E','4,000 B.C.E','d','e'];
  const mySwiper_main = new Swiper('.flow01 .swiper-main', {
    spaceBetween: 0,
    speed: 3000,
    followFinger: false,
    observeParents: true,
    on: {
      slideChange: (swiper) => {
        updateFraction(swiper.realIndex);
        finishAnimation();
      },
      slideChangeTransitionStart: (swiper) => {
        startAnimation(swiper.realIndex);
      },
      slideChangeTransitionEnd: () => {
        fractionNum.classList.remove('anm-started');
      },
    },
    centeredSlides: true,
    grabCursor: true,
    pagination: {
      el: '.flow01 .swiper-pagination-main',
      clickable: true,
      renderBullet: (index, className) => {
        let num = ('00' + (index + 1)).slice(-2);
        // return '<span class="' + className + '"><span class="step">STEP.</span>' + num + '</span>';
        return '<span class="' + className + '"><span class="step"></span>' + tag[index] + '</span>';
      },
    },
    navigation: {
      nextEl: '.flow01 .swiper-button-next',
      prevEl: '.flow01 .swiper-button-prev',
    },
    breakpoints: {
      1025: {
        spaceBetween: 0,
      }
    },
    keyboard: {
      enabled: true,
      onlyInViewport: false,
    },
  });
});
