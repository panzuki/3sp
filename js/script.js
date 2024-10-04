fetch('./js/swiper-bundle.min.js').then(r => { return r.text() }).then(t => {
let tag=['14,400 years ago','6,000 B.C.E','4,000 B.C.E','d','e'];
  const mySwiper_sub = new Swiper('.mv05 .swiper-sub', {
    spaceBetween: 24,
    grabCursor: true,
    nested: true,
    pagination: {
      el: '.mv05 .swiper-pagination-sub',
      clickable: true,
    },
  });

  const mySwiper_main = new Swiper('.mv05 .swiper-main', {
    spaceBetween: 24,
    centeredSlides: true,
    grabCursor: true,
    pagination: {
      el: '.mv05 .swiper-pagination-main',
      clickable: true,
      renderBullet: (index, className) => {
        let num = ('00' + (index + 1)).slice(-2);
        // return '<span class="' + className + '"><span class="step">STEP.</span>' + num + '</span>';
        return '<span class="' + className + '"><span class="step"></span>' + tag[index] + '</span>';
      },
    },
    navigation: {
      nextEl: '.mv05 .swiper-button-next',
      prevEl: '.mv05 .swiper-button-prev',
    },
    breakpoints: {
      1025: {
        spaceBetween: 80,
      }
    },
    keyboard: {
      enabled: true,
      onlyInViewport: false,
    },
  });
});
