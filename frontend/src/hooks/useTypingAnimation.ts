import { useState, useEffect } from 'react';

const WORDS = ["Research", "Risk Analysis", "Coding", "Design", "Reporting"];
const TYPING_SPEED = 80;
const DELETING_SPEED = 40;
const PAUSE_TIME = 2000;

export function useTypingAnimation() {
  const [text, setText] = useState('');
  const [wordIndex, setWordIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    
    const currentWord = WORDS[wordIndex];

    if (isDeleting) {
      if (text === '') {
        setIsDeleting(false);
        setWordIndex((prev) => (prev + 1) % WORDS.length);
      } else {
        timeout = setTimeout(() => {
          setText(currentWord.substring(0, text.length - 1));
        }, DELETING_SPEED);
      }
    } else {
      if (text === currentWord) {
        timeout = setTimeout(() => {
          setIsDeleting(true);
        }, PAUSE_TIME);
      } else {
        timeout = setTimeout(() => {
          setText(currentWord.substring(0, text.length + 1));
        }, TYPING_SPEED);
      }
    }

    return () => clearTimeout(timeout);
  }, [text, isDeleting, wordIndex]);

  return text;
}
