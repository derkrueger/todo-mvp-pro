import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
export default defineConfig({
  plugins:[
    react(),
    VitePWA({
      registerType:'autoUpdate',
      includeAssets:['favicon.ico','logo.svg'],
      manifest:{
        name:'What To Do', short_name:'WhatToDo',
        description:'Simple, schöne To‑Do App mit Listen & Archiv',
        theme_color:'#B3D5FF', background_color:'#F2F8FF',
        display:'standalone', start_url:'/#/start',
        icons:[
          {src:'/icons/icon-192.png',sizes:'192x192',type:'image/png'},
          {src:'/icons/icon-512.png',sizes:'512x512',type:'image/png'},
          {src:'/icons/maskable-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}
        ]
      },
      workbox:{globPatterns:['**/*.{js,css,html,ico,png,svg,woff2}']}
    })
  ]
})
