// script.js
const toggleButton = document.getElementById('theme-toggle');
const body = document.body;

// Check for saved user preference in localStorage
const currentTheme = localStorage.getItem('theme');
if (currentTheme) {
    body.classList.add(currentTheme);
}

// Toggle the theme and save preference in localStorage
toggleButton.addEventListener('click', () => {
    body.classList.toggle('dark');

    // Save the current theme in localStorage
    if (body.classList.contains('dark')) {
        localStorage.setItem('theme', 'dark');
    } else {
        localStorage.setItem('theme', 'light');
    }
});
