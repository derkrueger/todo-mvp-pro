/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        baby: {50:'#F7FBFF',100:'#F2F8FF',200:'#E4F0FF',300:'#D6E9FF',400:'#C4DFFF',500:'#B3D5FF',600:'#8EBEFF',700:'#6AA8FF',800:'#4D8EEB',900:'#3A6CB5'},
        check:'#22c55e'
      },
      boxShadow:{ soft:'0 8px 30px rgba(0,0,0,.06)' },
      borderRadius:{ xl2:'1.25rem' }
    },
  },
  plugins: [],
}
