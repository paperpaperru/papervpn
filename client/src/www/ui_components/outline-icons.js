/*
  Copyright 2020 The Outline Authors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

const $_documentContainer = document.createElement('template');

$_documentContainer.innerHTML = `<iron-iconset-svg name="outline-icons" size="24">
  <svg width="640" height="640" viewBox="0 0 640 640" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g id="outline" clip-path="url(#clip0_292_164)">
      <circle cx="320" cy="320" r="320" fill="#262823"/>
      <path d="M239.764 374.71H376.523C446.7 374.71 503.745 327.032 503.745 268.482C503.745 209.931 446.7 162.253 376.523 162.253H177.617V486.458H239.764V374.71ZM437.081 268.482C437.081 295.331 409.897 317.246 376.523 317.246H239.764V219.717H376.523C409.897 219.717 437.081 241.548 437.081 268.482Z" fill="#AEFF58"/>
    </g>
    <defs>
    <clipPath id="clip0_292_164">
      <rect width="640" height="640" fill="white"/>
    </clipPath>
    </defs>
  </svg>
</iron-iconset-svg>`;

document.head.appendChild($_documentContainer.content);
;
